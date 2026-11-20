import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import type { AutoBlock, AutoEvent, AutoPair, AutoPairInput, AutoStatus, AutoSyncApi } from '../../../shared/aut-types';
import { writeJsonAtomic } from '../manifest';
import { checkRoot, code, makePair, safePath, statMaybe } from './config';
import { copyAtomic, fault, stamp } from './copy';
import { Blocked, denial, type WritePermit } from './permit';
import { MAX_ATTEMPTS, queueState, retryDelay, type QueueState } from './queue';
import { recycleBytes, recyclePath } from './recycle';
import { keyFor, reconcile, type SyncData } from './sync';
import { watchPair } from './watcher';

export type { WritePermit, WriteDecision } from './permit';
interface Local extends SyncData {
  version: 1;
  pair: AutoPair | null; queue: QueueState; recent: AutoEvent[]; lastSync?: number;
  hold?: { reason: string; block?: AutoBlock; error?: boolean }; epoch?: string;
}
const cancelled = 'AUT_CANCELLED';
const blank = (): Local => ({ version: 1, pair: null, queue: queueState(), index: {}, recycle: [], recent: [] });
const reasonFor = (err: unknown) => {
  const labels: Record<string, string> = { ENOENT: '目录或文件不可用', EACCES: '权限不足', EPERM: '操作被拒绝或文件被占用', EBUSY: '文件被占用', ENOSPC: '磁盘空间不足', ENAMETOOLONG: '路径过长', EIO: '读写设备失败' };
  return labels[code(err) ?? ''] ?? (err instanceof Error && !code(err)?.startsWith('E') ? err.message : '文件操作失败');
};

export class AutoSync implements AutoSyncApi {
  private data = blank();
  private state: AutoStatus['state'] = 'off';
  private polling = false;
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private active = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closeWatcher?: () => void;
  private requested = false;
  private readonly loaded: Promise<void>;
  constructor(private readonly localDirectory: string, private readonly permit: WritePermit) {
    this.file = path.join(localDirectory, 'auto-sync.json');
    this.loaded = fs.readFile(this.file, 'utf8').then(text => {
      const parsed = JSON.parse(text) as Local;
      if (parsed.version !== 1 || !parsed.queue || !parsed.index || !Array.isArray(parsed.recycle) || !Array.isArray(parsed.recent)) throw new Error('自动备份状态损坏，已停止');
      this.data = parsed;
      this.showHold();
    }, err => { if (code(err) !== 'ENOENT') throw err; });
  }
  private run<T>(fn: () => Promise<T>) {
    const running = this.tail.then(() => this.loaded).then(fn);
    this.tail = running.catch(() => {});
    return running;
  }
  private save = () => writeJsonAtomic(this.file, this.data);
  private event = (action: string, detail?: string) => {
    this.data.recent.unshift({ at: Date.now(), action, detail });
    this.data.recent.length = Math.min(100, this.data.recent.length);
  };
  private showHold() {
    const h = this.data.hold;
    this.state = !this.data.pair?.enabled ? 'off' : h?.block?.code === 'offline' ? 'waiting' : h?.error ? 'error' : h ? 'paused' : 'idle';
  }
  private async decision(pair: AutoPair) {
    try {
      const d = await this.permit.canWrite({ ...pair, excludes: [...pair.excludes] });
      const block = denial(d);
      if (block) throw new Blocked(block);
      return d.epoch;
    } catch (err) {
      if (err instanceof Blocked) throw err;
      throw new Blocked({ code: 'denied', reason: '无法取得容灾写入许可' });
    }
  }
  private gate(pair: AutoPair, generation: number, epoch: string) {
    return async () => {
      if (!this.active || this.generation !== generation) throw fault(cancelled, '同步已停止');
      if (await this.decision(pair) !== epoch) throw new Blocked({ code: 'denied', reason: '介质或授权已变化，请核对后重新对账' });
      if (!this.active || this.generation !== generation) throw fault(cancelled, '同步已停止');
    };
  }
  private stopIO() { this.generation++; this.closeWatcher?.(); this.closeWatcher = undefined; clearTimeout(this.timer); }
  private async view(): Promise<AutoStatus> {
    await this.loaded;
    const { pair, queue, hold, recent, recycle, lastSync } = this.data;
    let available = !!pair;
    let reason = hold?.reason, block = hold?.block;
    if (pair) {
      try { await this.decision(pair); } catch (err) { if (err instanceof Blocked) { block = err.block; reason = block.reason; } available = false; }
      if (available) try {
        await checkRoot(pair.sourceRoot); await checkRoot(pair.targetRoot, constants.R_OK | constants.W_OK);
      } catch (err) { available = false; reason ??= reasonFor(err); }
    }
    const state = pair?.enabled && block ? block.code === 'offline' ? 'waiting' : 'paused' : this.state;
    return structuredClone({ pair, available, reason, block, state, polling: this.polling || !!pair?.pollOnly, pending: Number(queue.dirty || this.requested), attempts: queue.attempts, recent, recycle, recycleBytes: recycleBytes(recycle), lastSync });
  }
  status = () => this.view();
  /**
   * 自动同步是否正在执行。
   *
   * 重复文件检测的删除动作据此禁用（FR-10）：删正在被同步的文件会破坏 manifest 与断点。
   */
  isRunning = (): boolean => this.state === 'scanning' || this.state === 'syncing';
  configure = (input: AutoPairInput) => this.run(async () => {
    if (this.data.pair?.enabled) throw new Error('先关闭自动备份再修改设置');
    this.data.pair = await makePair(input, this.localDirectory, this.data.pair);
    this.event('配对设置已保存'); await this.save(); return this.view();
  });
  setEnabled = (enabled: boolean) => {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('开关参数无效'));
    if (!enabled) this.stopIO();
    return this.run(async () => {
      const p = this.data.pair;
      if (!p) throw new Error('请先保存目录配对');
      if (p.enabled === enabled) return this.view();
      if (enabled && !(await this.view()).available) throw new Error('目录或介质不可用，不能开启');
      p.enabled = enabled;
      if (!enabled) this.stopIO();
      this.data.queue = enabled ? { ...queueState(), dirty: true } : queueState();
      this.event(enabled ? '自动备份已开启' : '自动备份已关闭');
      this.showHold(); await this.save(); this.arm(); return this.view();
    });
  };
  resume = () => this.run(async () => {
    const p = this.data.pair;
    if (!p?.enabled || !this.active) throw new Error('请打开窗口并开启自动备份');
    this.data.epoch = await this.decision(p);
    delete this.data.hold;
    this.data.queue = { ...queueState(), dirty: true };
    this.event('用户确认重新对账'); this.showHold(); await this.save(); this.arm(); return this.view();
  });
  /** Host calls on window open; suspension never changes the persisted switch. */
  start = () => this.run(async () => { this.active = true; this.arm(); });
  suspend = () => { this.active = false; this.stopIO(); return this.tail.then(() => {}); };
  private arm() {
    const p = this.data.pair;
    if (!this.active || !p?.enabled || this.data.hold) return;
    this.stopIO();
    this.polling = p.pollOnly;
    this.closeWatcher = watchPair(p, () => this.request(), () => { this.polling = true; });
    this.schedule(this.data.queue.retryAt ? Math.max(0, this.data.queue.retryAt - Date.now()) : 0);
  }
  private schedule(ms: number) { clearTimeout(this.timer); this.timer = setTimeout(() => this.request(), ms); }
  private request() {
    if (this.requested) return;
    this.requested = true;
    const generation = this.generation;
    void this.run(async () => {
      this.requested = false;
      const p = this.data.pair;
      if (!p?.enabled || !this.active || this.data.hold || generation !== this.generation) return;
      const q = this.data.queue;
      if (q.retryAt > Date.now()) { this.schedule(q.retryAt - Date.now()); return; }
      q.dirty = true;
      await this.save();
      try {
        const epoch = await this.decision(p);
        if (this.data.epoch && this.data.epoch !== epoch) throw new Blocked({ code: 'denied', reason: '介质或授权已变化，请人工确认' });
        this.data.epoch = epoch;
        await this.save();
        this.state = 'scanning';
        await reconcile(p, this.data, this.permit, this.gate(p, generation, epoch), this.save, this.event, () => { this.state = 'syncing'; });
        this.data.lastSync = Date.now();
        this.data.queue = queueState(); this.state = 'idle';
      } catch (err) {
        if (code(err) === cancelled) return;
        let failure = err;
        if (!(failure instanceof Blocked)) try { await this.decision(p); } catch (blocked) { failure = blocked; }
        if (failure instanceof Blocked) {
          this.data.hold = { reason: failure.message, block: failure.block };
        } else {
          const reason = reasonFor(failure);
          const permanent = ['CONFLICT', 'RECYCLE_FULL', 'DELETE_RISK', 'ENAMETOOLONG', 'ENOSPC', 'EACCES'].includes(code(failure) ?? '');
          q.attempts++;
          if (permanent || q.attempts >= MAX_ATTEMPTS) this.data.hold = { reason, error: !permanent };
          else { q.retryAt = Date.now() + retryDelay(q.attempts); this.state = 'error'; }
          this.event(this.data.hold ? '同步已暂停' : '等待重试', reason);
        }
        if (this.data.hold) { this.event('同步阻断', this.data.hold.block?.code); this.showHold(); this.stopIO(); }
      }
      await this.save();
      if (this.active && p.enabled && !this.data.hold && generation === this.generation) this.schedule(this.data.queue.retryAt ? Math.max(0, this.data.queue.retryAt - Date.now()) : p.pollMs);
    }).catch(() => { this.state = 'error'; this.data.hold = { reason: '本机状态无法持久化，已停止写入', error: true }; this.stopIO(); });
  }
  restore = (id: string) => this.run(async () => {
    const p = this.data.pair;
    const entry = this.data.recycle.find(x => x.id === id && !x.pending);
    if (!p || !entry || !this.active) throw new Error('回收项不可用');
    const epoch = await this.decision(p);
    if (this.data.epoch !== epoch || this.data.hold?.block) throw new Error('请先确认介质并重新对账');
    const gate = this.gate(p, this.generation, epoch);
    await checkRoot(p.targetRoot);
    const src = await recyclePath(p, id);
    if ((await fs.lstat(src)).size !== entry.size) throw new Error('回收项大小已变更');
    const dest = await safePath(p.targetRoot, entry.relPath);
    const verifyDest = async () => { if (await statMaybe(await safePath(p.targetRoot, entry.relPath))) throw new Error('备份端已有同名项，未覆盖'); };
    await verifyDest();
    await gate(); await fs.mkdir(path.dirname(dest), { recursive: true });
    const part = await safePath(p.targetRoot, path.posix.join(path.posix.dirname(entry.relPath), `.aut-part-restore-${id}`));
    const hash = await copyAtomic(src, dest, part, 0, gate, verifyDest, true);
    const key = keyFor(entry.relPath);
    this.data.index[key] = { rel: entry.relPath, target: stamp(await fs.lstat(dest)), hash, restored: true };
    this.event('已恢复到备份目录'); await this.save(); return this.view();
  });
}
