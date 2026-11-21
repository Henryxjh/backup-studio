import { execFile } from 'node:child_process';
import { promises as fs, realpath, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { historyDir } from './manifest';
import { META_DIR } from './scan';
import type { PlanAction } from '../../shared/types';
import type { BackupRevealErrorCode, BackupRevealRequest, BackupRevealResult, BackupRevealSide } from '../../shared/reveal-types';

const messages: Record<BackupRevealErrorCode, string> = {
  INVALID_REQUEST: '定位请求无效。',
  FORBIDDEN_SENDER: '此页面不允许发起备份定位。',
  STALE_SCOPE: '备份计划或任务已变化，请刷新后重试。',
  NOT_REGISTERED: '当前备份计划或任务未登记此定位入口。',
  OUTSIDE_ROOT: '定位对象不在已授权的备份目录内。',
  UNSAFE_LINK: '定位路径包含符号链接或重解析点，已拒绝定位。',
  NOT_FOUND: '定位对象不存在，归档目录可能尚未创建。',
  PATH_CHANGED: '定位对象或其所在目录已变化，请重新扫描后重试。',
  INACCESSIBLE: '无法访问或安全验证定位对象。',
  SHELL_FAILED: '未能发起定位，请重试。',
};

export function revealError(code: BackupRevealErrorCode): BackupRevealResult {
  return { ok: false, code, message: messages[code] };
}

export function isRevealSender<T>(sender: T, expectedSender: T, frame: object | null,
  mainFrame: object, url: string | undefined, expectedUrl: string): boolean {
  return sender === expectedSender && frame === mainFrame && url === expectedUrl;
}

/**
 * 只读取**数据属性**。
 *
 * 定位请求来自渲染层，不能假设它是普通字面量：带 getter 的对象在求值时
 * 可能抛异常或产生副作用。因此带访问器的字段一律当作「读不到」，
 * 由上层按无效请求拒绝，而不是让异常穿透到 IPC。
 */
function dataProperty(target: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, field);
  if (!descriptor || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function parseRequest(value: unknown): BackupRevealRequest | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const request = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(request);
    const hasExactly = (...fields: string[]) => keys.length === fields.length && fields.every((key) => keys.includes(key));
    const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    const scopeId = dataProperty(request, 'scopeId');
    if (!id(scopeId)) return;
    const kind = dataProperty(request, 'kind');
    if (kind === 'archive' && hasExactly('kind', 'scopeId')) return { kind: 'archive', scopeId };
    const actionId = dataProperty(request, 'actionId');
    const side = dataProperty(request, 'side');
    if (kind === 'action' && hasExactly('kind', 'scopeId', 'actionId', 'side') && id(actionId) &&
        (side === 'source' || side === 'target' || side === 'renameFrom')) {
      return { kind: 'action', scopeId, actionId, side };
    }
  } catch {
    // 畸形请求（抛异常的 getter、Proxy 陷阱等）一律按无效请求拒绝：
    // 业务拒绝一律返回普通对象，绝不向上抛。
    return undefined;
  }
}

class Refusal extends Error {
  constructor(readonly code: BackupRevealErrorCode) { super(code); }
}

function ref(code: BackupRevealErrorCode): never { throw new Refusal(code); }

function failure(error: unknown): BackupRevealErrorCode {
  if (error instanceof Refusal) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'ELOOP') return 'UNSAFE_LINK';
  if (code === 'ENOTDIR') return 'PATH_CHANGED';
  return 'INACCESSIBLE';
}

function absolute(candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) ref('OUTSIDE_ROOT');
  if (process.platform === 'win32') {
    // Reject device syntax, ADS, and Win32 aliases before any path normalization.
    if (/^[\\/]{2}[?.][\\/]/.test(candidate) || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(candidate)) ref('OUTSIDE_ROOT');
    for (const part of candidate.replace(/^[A-Za-z]:/, '').split(/[\\/]+/)) {
      if (part && (/[:<>"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) ref('OUTSIDE_ROOT');
    }
  }
  return path.resolve(candidate);
}

function inside(root: string, candidate: string): string {
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) ref('OUTSIDE_ROOT');
  return rel;
}

function ordinaryFile(rel: string): boolean {
  return !rel.split(path.sep).some((part) => part.toLowerCase() === META_DIR || part.toLowerCase().endsWith('.part'));
}

export interface RevealFileSystem {
  lstat(file: string): Promise<BigIntStats>;
  realpath(file: string): Promise<string>;
  /** On Windows, query FILE_ATTRIBUTE_REPARSE_POINT, including non-symlink tags. */
  reparsePoints(files: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
}

// Node Stats exposes junctions as links but does not expose all Windows reparse tags.
// The script is fixed; paths are JSON data on stdin, never interpolated into a command.
async function reparsePoints(files: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
  if (process.platform !== 'win32') return new Map(files.map((file) => [file, false]));
  if (!files.length) return new Map();
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $items=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); foreach ($p in $items) { try { if ([IO.File]::GetAttributes([string]$p) -band [IO.FileAttributes]::ReparsePoint) { '1' } else { '0' } } catch { '?' } }";
  const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile(program, ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: Math.max(1024, files.length * 4) },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify(files), 'utf8');
  });
  const flags = result.trim().split(/\r?\n/);
  if (flags.length !== files.length) ref('INACCESSIBLE');
  return new Map(files.flatMap((file, i) => flags[i] === '?' ? [] : [[file, flags[i] === '1']]));
}

const disk: RevealFileSystem = {
  lstat: (file) => fs.lstat(file, { bigint: true }),
  realpath: promisify(realpath.native),
  reparsePoints,
};

type Node = { file: string; real: string; stat: BigIntStats };
type Candidate = { root: string; file: string; kind: 'file' | 'dir' };
type Entry = { candidate: Candidate; nodes: Node[] };
type Registration = { entry: Entry } | { denied: BackupRevealErrorCode };
type Scope = { scopeId: string; actions: Map<string, Map<BackupRevealSide, Registration>>; archive?: Registration };
type Roots = { scopeId: string; sourceRoot: string; targetRoot: string };

function sameNode(before: Node, after: Node, kind: 'file' | 'dir'): boolean {
  const a = before.stat;
  const b = after.stat;
  return before.real === after.real && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs &&
    (kind === 'dir' || (a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs));
}

export class RevealAuthority {
  private generation = 0;
  private scope?: Scope;

  constructor(private readonly io: RevealFileSystem = disk) {}

  get scopeId(): string | undefined { return this.scope?.scopeId; }

  invalidate(_reason: string): void {
    this.generation++;
    this.scope = undefined;
  }

  async publishPlan(input: Roots & { actions: readonly PlanAction[]; archive?: boolean }): Promise<void> {
    await this.publish(input, input.actions, input.archive === true);
  }

  async bindJob(input: Roots & { jobId: string; archive?: boolean }): Promise<void> {
    // Running mutations must not create or re-baseline action-file grants.
    await this.publish(input, [], input.archive === true);
  }

  async publishArchive(input: { scopeId: string; targetRoot: string }): Promise<void> {
    await this.publish({ ...input, sourceRoot: input.targetRoot }, [], true);
  }

  private async publish(input: Roots, actions: readonly PlanAction[], archive: boolean): Promise<void> {
    this.invalidate('publication');
    const generation = this.generation;
    const scope: Scope = { scopeId: input.scopeId, actions: new Map() };
    const entries: { registration: Registration; set: (registration: Registration) => void }[] = [];
    const cache = new Map<string, Promise<Node>>();
    const add = async (root: string, file: () => string, kind: Candidate['kind'], set: (r: Registration) => void) => {
      try {
        root = absolute(root);
        const candidate = { root, file: file(), kind };
        const rel = inside(root, candidate.file);
        if (kind === 'file' && !ordinaryFile(rel)) ref('NOT_REGISTERED');
        const nodes = await this.inspect(candidate, cache);
        entries.push({ registration: { entry: { candidate, nodes } }, set });
      } catch (error) {
        // A rejected candidate contributes only a reason, not an authorized path.
        const code = failure(error);
        set({ denied: code === 'NOT_FOUND' && kind === 'file' ? 'NOT_REGISTERED' : code });
      }
    };
    if (archive) await add(input.targetRoot, () => historyDir(absolute(input.targetRoot)), 'dir', (r) => { scope.archive = r; });
    for (const action of actions) {
      if (generation !== this.generation) return;
      const sides = new Map<BackupRevealSide, Registration>();
      scope.actions.set(action.id, sides);
      if (action.srcPath) await add(input.sourceRoot, () => absolute(action.srcPath!), 'file', (r) => sides.set('source', r));
      if (action.dstPath) await add(input.targetRoot, () => absolute(action.dstPath!), 'file', (r) => sides.set('target', r));
      if (action.type === 'rename' && action.fromRelPath) {
        await add(input.targetRoot, () => {
          const rel = action.fromRelPath!;
          if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === '..' || part === '.')) ref('OUTSIDE_ROOT');
          return absolute(path.join(input.targetRoot, rel));
        }, 'file', (r) => sides.set('renameFrom', r));
      }
    }
    if (generation !== this.generation) return;
    const observed = new Set<string>();
    for (const { registration } of entries) if ('entry' in registration) {
      for (const node of registration.entry.nodes) observed.add(node.file);
    }
    let flags: ReadonlyMap<string, boolean>;
    try { flags = await this.io.reparsePoints([...observed]); }
    catch { flags = new Map(); }
    for (const { registration, set } of entries) {
      if (!('entry' in registration)) continue;
      try { this.checkReparse(registration.entry.nodes, flags); set(registration); }
      catch (error) { set({ denied: failure(error) }); }
    }
    if (generation === this.generation) this.scope = scope;
  }

  private async inspect(candidate: Candidate, cache = new Map<string, Promise<Node>>()): Promise<Node[]> {
    inside(candidate.root, candidate.file);
    const paths = [candidate.file];
    while (path.dirname(paths[paths.length - 1]) !== paths[paths.length - 1]) paths.push(path.dirname(paths[paths.length - 1]));
    paths.reverse();
    const nodes: Node[] = [];
    let rootNode: Node | undefined;
    for (const file of paths) {
      let pending = cache.get(file);
      if (!pending) {
        pending = (async () => {
          const stat = await this.io.lstat(file);
          if (stat.isSymbolicLink()) ref('UNSAFE_LINK');
          return { file, stat, real: await this.io.realpath(file) };
        })();
        cache.set(file, pending);
      }
      const node = await pending;
      const kind = file === candidate.file ? candidate.kind : 'dir';
      if (!(kind === 'dir' ? node.stat.isDirectory() : node.stat.isFile())) ref('PATH_CHANGED');
      const parent = nodes[nodes.length - 1];
      // A canonical spelling can differ in case on Windows; do not accept redirects.
      const expected = parent ? path.join(parent.real, path.basename(file)) : file;
      if (path.relative(expected, node.real) !== '') ref('UNSAFE_LINK');
      if (file === candidate.root || path.relative(file, candidate.root) === '') rootNode = node;
      nodes.push(node);
    }
    if (!rootNode) ref('OUTSIDE_ROOT');
    inside(rootNode.real, nodes[nodes.length - 1].real);
    return nodes;
  }

  private checkReparse(nodes: Node[], flags: ReadonlyMap<string, boolean>): void {
    if (nodes.some(({ file }) => flags.get(file) === true)) ref('UNSAFE_LINK');
    if (nodes.some(({ file }) => flags.get(file) !== false)) ref('INACCESSIBLE');
  }

  async reveal(value: unknown, dispatch: (absolutePath: string) => void,
    senderStillValid: () => boolean = () => true): Promise<BackupRevealResult> {
    if (!senderStillValid()) return revealError('FORBIDDEN_SENDER');
    const request = parseRequest(value);
    if (!request) return revealError('INVALID_REQUEST');
    const scope = this.scope;
    if (!scope || request.scopeId !== scope.scopeId) return revealError('STALE_SCOPE');
    const registration = request.kind === 'archive' ? scope.archive : scope.actions.get(request.actionId)?.get(request.side);
    if (!registration) return revealError('NOT_REGISTERED');
    if ('denied' in registration) return revealError(registration.denied);
    const { candidate, nodes: before } = registration.entry;
    let after: Node[];
    try {
      this.checkReparse(before, await this.io.reparsePoints(before.map(({ file }) => file)));
      after = await this.inspect(candidate);
      if (after.length !== before.length || after.some((node, i) => !sameNode(before[i], node, i === after.length - 1 ? candidate.kind : 'dir'))) {
        ref('PATH_CHANGED');
      }
    } catch (error) { return revealError(failure(error)); }
    if (scope !== this.scope) return revealError('STALE_SCOPE');
    if (!senderStillValid()) return revealError('FORBIDDEN_SENDER');
    try { dispatch(after[after.length - 1].real); }
    catch { return revealError('SHELL_FAILED'); }
    return { ok: true };
  }
}
