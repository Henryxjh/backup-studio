import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DupActRequest, DupActResult, DupCategory } from '../../../shared/dup-types';
import { hashPartialFile } from './hash';
import { hashFile } from '../hash';
import { writeJsonAtomic } from '../manifest';
import type { DupAuditEntry } from './audit';

/**
 * 删除执行层（FR-08 ~ FR-11、FR-20、FR-21）。
 *
 * 执行顺序固定为：**前置校验 → 二次校验 → 落地**，逐条独立：
 * 任何一条失败都不影响其余条目，失败原因逐条如实返回。
 *
 * 落地方式只有两种：系统回收站，或降级到本机隔离区。
 * **任何情况下都不提供永久删除。**
 */

/** 扫描结果登记表中的一条：删除前的比对基准 */
export interface ActRegistryEntry {
  id: string;
  absPath: string;
  relPath: string;
  /** 扫描时记录的内容哈希（疑似项为局部哈希） */
  sha256: string;
  size: number;
  dev: string;
  ino: string;
  /** 疑似项：只做过局部校验，复核也只做局部校验 */
  suspected?: boolean;
  /** 所属组 */
  groupId: string;
}

export interface ActOptions {
  /** 扫描根 */
  root: string;
  /** 待删条目（来自渲染层，必须逐条校验） */
  items: DupActRequest['items'];
  /** 确认类别 */
  category: DupCategory;
  /** 扫描结果登记表：绝对路径 → 条目 */
  registry: Map<string, ActRegistryEntry>;
  /** 组 → 组内全部条目 id（用于「每组至少保留一份」） */
  groupMembers: Map<string, string[]>;
  /** 写入闸门 */
  gate?: (root: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** 备份 / 自动同步是否在运行 */
  isBusy?: () => boolean;
  /** 系统回收站落地；抛错视为回收站不可用 → 降级隔离区 */
  trash?: (absPath: string) => Promise<void>;
  /** 本机隔离区目录 */
  quarantineDirectory: string;
  /** 抑制判定：内容哈希被抑制时不得删除 */
  isSuppressed?: (sha256: string) => boolean;
  /** 审计写入 */
  audit: (entry: DupAuditEntry) => Promise<void> | void;
  /** 取消：停止处理剩余条目 */
  isCancelled?: () => boolean;
}

/** 隔离区条目：记录原路径映射，可还原 */
export interface QuarantineEntry {
  id: string;
  /** 原路径（还原目标） */
  originalPath: string;
  /** 隔离区内的实际存放路径 */
  storedPath: string;
  size: number;
  sha256: string;
  createdAt: number;
}

interface QuarantineFile {
  version: 1;
  updatedAt: number;
  items: QuarantineEntry[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** 网络盘 / UNC 路径：回收站语义不可靠，默认拒绝删除（FR-21） */
export function isNetworkPath(target: string): boolean {
  const normalized = target.replace(/\//g, '\\');
  return normalized.startsWith('\\\\');
}

/**
 * 跨卷移动：同盘用 rename，跨盘退化为「复制 + 删除源文件」。
 *
 * 隔离区在本机 userData，文件可能在别的卷上，因此必须处理 EXDEV。
 */
async function moveFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if (errorCode(err) !== 'EXDEV') throw err;
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
}

/**
 * 本机隔离区（回收站不可用时的降级目标，FR-08）。
 *
 * 记录原路径映射，随时可还原；只写本机。
 */
export class QuarantineStore {
  constructor(readonly directory: string) {}

  private get file(): string {
    return path.join(this.directory, 'index.json');
  }

  async list(): Promise<QuarantineEntry[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
      return parsed.items;
    } catch {
      return [];
    }
  }

  private async write(items: QuarantineEntry[]): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, updatedAt: Date.now(), items } satisfies QuarantineFile);
  }

  /** 移入隔离区并登记原路径 */
  async store(originalPath: string, size: number, sha256: string): Promise<QuarantineEntry> {
    const id = randomUUID();
    const storedPath = path.join(this.directory, 'files', id, path.basename(originalPath));
    await moveFile(originalPath, storedPath);
    const entry: QuarantineEntry = { id, originalPath, storedPath, size, sha256, createdAt: Date.now() };
    const items = await this.list();
    items.push(entry);
    await this.write(items);
    return entry;
  }

  /**
   * 还原隔离区中的文件。
   *
   * 还原失败时保留登记项：文件还在隔离区，用户可以再次尝试。
   */
  async restore(id: string): Promise<{ restored: boolean; path?: string; reason?: string }> {
    const items = await this.list();
    const entry = items.find((item) => item.id === id);
    if (!entry) return { restored: false, reason: '隔离区中没有这条记录，可能已被还原' };
    try {
      await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
      await moveFile(entry.storedPath, entry.originalPath);
    } catch (err) {
      return { restored: false, reason: `还原失败：${errorText(err)}` };
    }
    await this.write(items.filter((item) => item.id !== id));
    return { restored: true, path: entry.originalPath };
  }
}

/**
 * 执行一次删除动作。
 *
 * 返回值逐条对应请求中的条目，**失败不伪装成功**：
 * - `deleted`：已落地（系统回收站或隔离区）；
 * - `skipped-changed`：扫描后文件已变更，已跳过；
 * - `blocked`：被闸门、备份互斥、抑制、符号链接或「至少留一份」拒绝；
 * - `failed`：落地失败等真实错误。
 */
export async function executeAct(options: ActOptions): Promise<DupActResult> {
  const quarantine = new QuarantineStore(options.quarantineDirectory);
  const items: DupActResult['items'] = [];
  let deleted = 0;
  let skipped = 0;
  let blocked = 0;
  let failed = 0;
  let reclaimedBytes = 0;
  let degradedToQuarantine = false;

  const audit = (entry: DupAuditEntry): void => {
    void options.audit(entry);
  };

  // ---- 前置校验：备份互斥与写入闸门（FR-10）----
  // 这两条是全局性的：一旦不满足，整批删除都不执行。
  if (options.isBusy?.()) {
    const reason = '备份任务或自动同步正在运行，删除动作已禁用';
    for (const item of options.items) {
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
    }
    blocked += options.items.length;
    return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine };
  }
  if (options.gate) {
    const verdict = await options.gate(options.root);
    if (!verdict.allowed) {
      const reason = verdict.reason ?? '写入闸门未放行，已拒绝删除';
      for (const item of options.items) {
        items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
        audit({ at: Date.now(), action: '删除被闸门阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
      }
      blocked += options.items.length;
      return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine };
    }
  }

  // ---- 逐条校验与执行 ----
  // 先按组归拢请求，用于「每组至少保留一份」的硬约束（FR-11）。
  const requestedByGroup = new Map<string, Set<string>>();
  for (const item of options.items) {
    const entry = options.registry.get(item.absPath);
    if (!entry) continue;
    const set = requestedByGroup.get(entry.groupId) ?? new Set<string>();
    set.add(entry.id);
    requestedByGroup.set(entry.groupId, set);
  }

  for (const item of options.items) {
    if (options.isCancelled?.()) {
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason: '用户取消，已停止处理剩余条目' });
      blocked++;
      continue;
    }

    const entry = options.registry.get(item.absPath);
    if (!entry) {
      // 伪造路径或不是本次扫描结果的条目：一律拒绝并记审计（FR-20）
      const reason = '路径不在本次扫描结果内，已拒绝';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除请求被拒绝', path: item.absPath, groupId: item.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }
    // 渲染层传来的内容必须与扫描记录一致，防止篡改（FR-20）
    if (item.sha256 !== entry.sha256 || item.size !== entry.size) {
      const reason = '请求内容与扫描记录不一致，已拒绝';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除请求被拒绝', path: item.absPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }

    // 抑制项在执行删除时同样生效（FR-12）
    if (options.isSuppressed?.(entry.sha256)) {
      const reason = '该内容已被抑制（下次不提醒），不参与删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被抑制', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // 每组至少保留一份（FR-11）
    const members = options.groupMembers.get(entry.groupId) ?? [];
    const requested = requestedByGroup.get(entry.groupId) ?? new Set<string>();
    if (members.length > 0 && requested.size >= members.length) {
      const reason = '该组至少保留一份，已拒绝清空整组';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // ---- 删除前二次校验（FR-09）----
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(item.absPath);
    } catch (err) {
      const reason = `无法访问文件：${errorText(err)}`;
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }
    // 符号链接复查：扫描后被替换成链接的文件不删（FR-20）
    if (stat.isSymbolicLink()) {
      const reason = '删除前复查：目标已变为符号链接，已拒绝删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }
    if (stat.size !== entry.size) {
      const reason = '扫描后已变更，已跳过';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
      audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
      skipped++;
      continue;
    }
    if (String(stat.dev) !== entry.dev || String(stat.ino) !== entry.ino) {
      const reason = '扫描后已变更，已跳过（文件身份与扫描时不一致）';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
      audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
      skipped++;
      continue;
    }
    // 内容哈希复核：疑似项按局部哈希复核，确定项按全量哈希复核
    try {
      const current = entry.suspected
        ? (await hashPartialFile(item.absPath, stat.size)).hash
        : await hashFile(item.absPath);
      if (current !== entry.sha256) {
        const reason = '扫描后已变更，已跳过（内容哈希不一致）';
        items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
        audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
        skipped++;
        continue;
      }
    } catch (err) {
      const reason = `复核读取失败：${errorText(err)}`;
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }

    // 网络盘 / 只读位置：默认拒绝删除（FR-21）
    if (isNetworkPath(item.absPath)) {
      const reason = '网络盘 / UNC 路径上的删除已默认拒绝，请改为「仅标记不删除」';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }
    try {
      await fs.access(path.dirname(item.absPath), fsConstants.W_OK);
    } catch {
      const reason = '所在位置不可写（只读卷或权限不足），已拒绝删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // ---- 落地：系统回收站，失败则降级到本机隔离区（FR-08）----
    let landedTo: 'system-trash' | 'quarantine' = 'system-trash';
    let quarantineId: string | undefined;
    try {
      if (!options.trash) throw new Error('未配置回收站落地能力');
      await options.trash(item.absPath);
    } catch (err) {
      try {
        const stored = await quarantine.store(item.absPath, entry.size, entry.sha256);
        landedTo = 'quarantine';
        quarantineId = stored.id;
        degradedToQuarantine = true;
      } catch (quarantineError) {
        const reason = `删除失败：${errorText(err)}；降级到本机隔离区也失败：${errorText(quarantineError)}`;
        items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
        audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
        failed++;
        continue;
      }
    }
    deleted++;
    reclaimedBytes += entry.size;
    items.push({
      id: item.id,
      absPath: item.absPath,
      outcome: 'deleted',
      reason: landedTo === 'quarantine' ? '已移入本机隔离区（系统回收站不可用），可还原' : '已移入系统回收站',
      landedTo,
      quarantineId,
    });
    audit({
      at: Date.now(),
      action: '删除',
      path: item.absPath,
      relPath: entry.relPath,
      groupId: entry.groupId,
      outcome: 'ok',
      reason: landedTo === 'quarantine' ? '降级到本机隔离区' : '系统回收站',
    });
  }

  return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine };
}
