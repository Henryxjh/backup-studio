import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DuplicateFinder } from '../electron/engine/dup';
import { detectDuplicates } from '../electron/engine/dup/detect';
import { buildPlan } from '../electron/engine/planner';
import { scanTree, type ScannedTree } from '../electron/engine/scan';
import type { DupReport, DupStatus } from '../shared/dup-types';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}

const put = async (root: string, rel: string, text: string) => {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
};

/** 临时目录夹具：源端、目标端、本机状态目录三件套 */
async function fixture(
  fn: (ctx: {
    sourceRoot: string;
    targetRoot: string;
    local: string;
    finder: DuplicateFinder;
    changes: string[];
  }) => Promise<void>,
) {
  const base = await fs.mkdtemp(path.resolve('test', '.dup-fixture-'));
  const sourceRoot = path.join(base, 'source');
  const targetRoot = path.join(base, 'target');
  const local = path.join(base, 'local');
  await fs.mkdir(sourceRoot);
  await fs.mkdir(targetRoot);
  await fs.mkdir(local);
  const changes: string[] = [];
  const finder = new DuplicateFinder(local, {
    onExclusionsChanged: (_root, reason) => changes.push(reason),
  });
  try { await fn({ sourceRoot, targetRoot, local, finder, changes }); }
  finally { await fs.rm(base, { recursive: true }); }
}

/** 目录快照：用于验证扫描全程只读（不新建目录、不写文件） */
async function snapshot(root: string): Promise<string> {
  const tree = await scanTree(root, { excludeMetaDir: false });
  const parts = [`dirs:${[...tree.dirs].sort().join(',')}`];
  for (const file of [...tree.files.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
    parts.push(`${file.relPath}|${file.size}`);
  }
  return parts.join('\n');
}

const emptyTree = (root: string): ScannedTree => ({
  root,
  files: new Map(),
  dirs: [],
  totalBytes: 0,
  skippedSymlinks: 0,
  errors: [],
});

const reportOf = (status: DupStatus): DupReport => {
  assert.ok(status.report, '扫描后应有报告');
  return status.report;
};

async function main() {
  // ---- 判定引擎 ----

  await test('源端内部重复被正确分组，规范副本取字典序最小者', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'b/two.txt', 'same-content');
    await put(sourceRoot, 'a/one.txt', 'same-content');
    await put(sourceRoot, 'c/unique.txt', 'different');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.totalGroups, 1);
    const group = report.groups[0];
    assert.equal(group.copies.length, 2);
    assert.equal(group.relation, 'source-internal');
    assert.equal(group.canonical, 'a/one.txt');
    assert.deepEqual(group.redundant.map((c) => c.relPath), ['b/two.txt']);
    assert.equal(group.reclaimableBytes, 'same-content'.length);
    assert.equal(group.adoptable, true);
  }));

  await test('size 分桶前置：尺寸唯一的文件不进入哈希阶段', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    for (let i = 0; i < 40; i += 1) await put(sourceRoot, `uniq/${i}.bin`, `x${i}`.padEnd(100 + i, 'p'));
    await put(sourceRoot, 'dup/a.bin', 'identical');
    await put(sourceRoot, 'dup/b.bin', 'identical');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.scannedFiles, 42);
    assert.ok(report.hashedFiles <= 4, `哈希文件数应远小于扫描文件数，实际 ${report.hashedFiles}`);
    assert.equal(report.totalGroups, 1);
  }));

  await test('跨端重复：源端与目标端路径不同但内容相同', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'doc/a.txt', 'payload');
    await put(targetRoot, 'a.txt', 'payload');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.totalGroups, 1);
    const group = report.groups[0];
    assert.equal(group.relation, 'cross-side');
    assert.equal(group.canonical, 'doc/a.txt');
    // 跨端重复的目标端副本不作为可排除对象：处置权归计划器的改名配对
    assert.equal(group.redundant.length, 0);
    assert.equal(group.adoptable, false);
  }));

  await test('源端与目标端相对路径相同且内容相同的不算重复', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'a.txt', 'payload');
    await put(targetRoot, 'a.txt', 'payload');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.totalGroups, 0);
    assert.equal(report.groups.length, 0);
  }));

  await test('哈希读取失败的文件不参与分组，报告标注覆盖不完整', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.dup-unit-'));
    try {
      const root = path.join(base, 'source');
      await fs.mkdir(root);
      await put(root, 'good.txt', 'payload');
      // 手工注入一个指向不存在文件的条目，构造确定的哈希读取失败
      const source = emptyTree(root);
      source.files.set('good.txt', { relPath: 'good.txt', size: 7, mtimeMs: 1 });
      source.files.set('ghost.txt', { relPath: 'ghost.txt', size: 7, mtimeMs: 1 });
      const result = await detectDuplicates({
        sourceRoot: root,
        targetRoot: path.join(base, 'target'),
        source,
        target: emptyTree(path.join(base, 'target')),
        manifest: null,
      });
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].relPath, 'ghost.txt');
      assert.equal(result.failures[0].side, 'source');
      // 失败文件不得被并入任何分组
      assert.ok(!result.groups.some((g) => g.copies.some((c) => c.relPath === 'ghost.txt')));
      assert.ok(!result.groups.some((g) => g.copies.some((c) => c.relPath === 'good.txt')));
    } finally { await fs.rm(base, { recursive: true }); }
  });

  await test('连续两次扫描结果完全一致（规范副本选取确定性）', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'z/last.txt', 'same');
    await put(sourceRoot, 'a/first.txt', 'same');
    await put(sourceRoot, 'm/mid.txt', 'same');
    const first = reportOf(await finder.scan(sourceRoot, targetRoot));
    const second = reportOf(await finder.scan(sourceRoot, targetRoot));
    const shape = (r: DupReport) =>
      r.groups.map((g) => [g.hash, g.canonical, g.redundant.map((c) => c.relPath).join(',')]);
    assert.deepEqual(shape(first), shape(second));
    assert.equal(first.groups[0].canonical, 'a/first.txt');
  }));

  await test('零字节文件成组且不提供排除入口', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'empty-a.txt', '');
    await put(sourceRoot, 'empty-b.txt', '');
    await put(sourceRoot, 'data.txt', 'x');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.totalGroups, 1);
    const group = report.groups[0];
    assert.equal(group.zeroByte, true);
    assert.equal(group.adoptable, false);
  }));

  // ---- 计划器接入 ----

  await test('排除名单抑制复制动作，但源端文件数统计不变', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.dup-plan-'));
    try {
      const sourceRoot = path.join(base, 'source');
      const targetRoot = path.join(base, 'target');
      await fs.mkdir(sourceRoot);
      await fs.mkdir(targetRoot);
      await put(sourceRoot, 'a/keep.txt', 'payload');
      await put(sourceRoot, 'b/dup.txt', 'payload');
      const source = await scanTree(sourceRoot, { excludeMetaDir: false });
      const target = await scanTree(targetRoot, { excludeMetaDir: true });

      const full = await buildPlan({ sourceRoot, targetRoot, source, target, manifest: null, syncMode: 'mirror' });
      assert.equal(full.actions.filter((a) => a.type === 'copy').length, 2);

      const excluded = await buildPlan({
        sourceRoot, targetRoot, source, target, manifest: null, syncMode: 'mirror',
        excluded: new Set(['b/dup.txt']),
      });
      const actions = excluded.actions.map((a) => `${a.type}:${a.relPath}`);
      assert.ok(!actions.includes('copy:b/dup.txt'), '被排除副本不应产生复制动作');
      assert.ok(actions.includes('copy:a/keep.txt'));
      assert.equal(excluded.summary.copy, 1);
      // 源端文件数统计不变
      assert.equal(excluded.summary.totalFiles, 2);
    } finally { await fs.rm(base, { recursive: true }); }
  });

  await test('命中排除名单的孤儿不生成删除动作', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.dup-orphan-'));
    try {
      const sourceRoot = path.join(base, 'source');
      const targetRoot = path.join(base, 'target');
      await fs.mkdir(sourceRoot);
      await fs.mkdir(targetRoot);
      await put(sourceRoot, 'keep.txt', 'payload');
      await put(targetRoot, 'keep.txt', 'payload');
      await put(targetRoot, 'orphan.txt', 'other');
      const source = await scanTree(sourceRoot, { excludeMetaDir: false });
      const target = await scanTree(targetRoot, { excludeMetaDir: true });

      const without = await buildPlan({ sourceRoot, targetRoot, source, target, manifest: null, syncMode: 'mirror' });
      assert.ok(without.actions.some((a) => a.type === 'delete' && a.relPath === 'orphan.txt'));

      const excluded = await buildPlan({
        sourceRoot, targetRoot, source, target, manifest: null, syncMode: 'mirror',
        excluded: new Set(['orphan.txt']),
      });
      assert.ok(
        !excluded.actions.some((a) => a.type === 'delete' && a.relPath === 'orphan.txt'),
        '排除名单命中的孤儿不应产生删除动作',
      );
    } finally { await fs.rm(base, { recursive: true }); }
  });

  // ---- 编排层 ----

  await test('采纳排除后冗余副本不再写入目标端，源端文件一个不动', () => fixture(async ({ sourceRoot, targetRoot, finder, changes }) => {
    await put(sourceRoot, 'a/keep.txt', 'payload');
    await put(sourceRoot, 'b/dup.txt', 'payload');
    const before = await snapshot(sourceRoot);
    const status = await finder.scan(sourceRoot, targetRoot);
    const group = reportOf(status).groups[0];
    assert.ok(group.adoptable);

    const after = await finder.adopt([group.hash]);
    assert.equal(after.excludedCount, 1);
    assert.deepEqual(after.excludedPaths, ['b/dup.txt']);
    assert.equal(changes.length, 1, '排除名单变更应触发回调');

    // 源端文件未被删除、移动或改名
    assert.equal(await snapshot(sourceRoot), before);
    await fs.stat(path.join(sourceRoot, 'b/dup.txt'));
  }));

  await test('撤销排除后恢复复制行为', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'a/keep.txt', 'payload');
    await put(sourceRoot, 'b/dup.txt', 'payload');
    const group = reportOf(await finder.scan(sourceRoot, targetRoot)).groups[0];
    await finder.adopt([group.hash]);
    assert.equal((await finder.status()).excludedCount, 1);
    await finder.revoke();
    assert.equal((await finder.status()).excludedCount, 0);

    const source = await scanTree(sourceRoot, { excludeMetaDir: false });
    const target = await scanTree(targetRoot, { excludeMetaDir: true });
    const plan = await buildPlan({ sourceRoot, targetRoot, source, target, manifest: null, syncMode: 'mirror' });
    assert.equal(plan.actions.filter((a) => a.type === 'copy').length, 2);
  }));

  await test('目标端既有冗余副本默认不被处置', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'a/keep.txt', 'payload');
    await put(sourceRoot, 'b/dup.txt', 'payload');
    await put(targetRoot, 'legacy/dup.txt', 'payload');
    const targetBefore = await snapshot(targetRoot);
    const group = reportOf(await finder.scan(sourceRoot, targetRoot)).groups[0];
    await finder.adopt([group.hash]);
    assert.equal(await snapshot(targetRoot), targetBefore, '目标端不应被写入或删除');
    await fs.stat(path.join(targetRoot, 'legacy/dup.txt'));
  }));

  await test('扫描全程只读：源端与目标端目录树不变', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'a/one.txt', 'payload');
    await put(sourceRoot, 'b/two.txt', 'payload');
    await put(targetRoot, 'old.txt', 'previous');
    const sourceBefore = await snapshot(sourceRoot);
    const targetBefore = await snapshot(targetRoot);
    await finder.scan(sourceRoot, targetRoot);
    assert.equal(await snapshot(sourceRoot), sourceBefore);
    assert.equal(await snapshot(targetRoot), targetBefore);
    // 不得产生 .part 临时件
    const stray = await fs.readdir(targetRoot);
    assert.ok(!stray.some((n) => n.endsWith('.part')), `目标端出现临时件：${stray.join(',')}`);
  }));

  await test('报告可导出为 JSON 与 CSV，内容为全量', () => fixture(async ({ sourceRoot, targetRoot, finder, local }) => {
    await put(sourceRoot, 'a/one.txt', 'payload');
    await put(sourceRoot, 'b/two.txt', 'payload');
    await put(sourceRoot, 'c/three.txt', 'payload');
    const report = reportOf(await finder.scan(sourceRoot, targetRoot));
    assert.equal(report.totalGroups, 1);

    const json = await finder.exportReport('json');
    const parsed = JSON.parse(await fs.readFile(json.path, 'utf8')) as DupReport;
    assert.equal(parsed.totalGroups, report.totalGroups);
    assert.equal(parsed.groups.length, report.groups.length);

    const csv = await finder.exportReport('csv');
    const rows = (await fs.readFile(csv.path, 'utf8')).trim().split('\n');
    // 表头 + 每个副本一行
    assert.equal(rows.length, 1 + report.groups[0].copies.length);
    assert.ok(rows[0].startsWith('hash,size,relation,relPath'));
    // 导出物落在本机状态目录，不污染备份集
    assert.ok(json.path.startsWith(local));
  }));

  await test('排除名单持久化：重新打开仍生效', () => fixture(async ({ sourceRoot, targetRoot, local, finder }) => {
    await put(sourceRoot, 'a/keep.txt', 'payload');
    await put(sourceRoot, 'b/dup.txt', 'payload');
    const group = reportOf(await finder.scan(sourceRoot, targetRoot)).groups[0];
    await finder.adopt([group.hash]);

    const reopened = new DuplicateFinder(local);
    const status = await reopened.status();
    assert.equal(status.excludedCount, 1);
    assert.deepEqual(status.excludedPaths, ['b/dup.txt']);
    const paths = await reopened.exclusionPaths(sourceRoot);
    assert.ok(paths.has('b/dup.txt'));
  }));

  await test('源端不可达时明确报错，不产出空报告', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'a/one.txt', 'payload');
    await assert.rejects(finder.scan(path.join(sourceRoot, 'missing'), targetRoot));
    assert.equal((await finder.status()).report, null);
  }));

  await test('源与目标相同或互相包含时拒绝扫描', () => fixture(async ({ sourceRoot, finder }) => {
    await assert.rejects(finder.scan(sourceRoot, sourceRoot), /互相包含/);
    const nested = path.join(sourceRoot, 'nested');
    await fs.mkdir(nested);
    await assert.rejects(finder.scan(sourceRoot, nested), /互相包含/);
  }));

  await test('不可采纳的重复组不能被排除', () => fixture(async ({ sourceRoot, targetRoot, finder }) => {
    await put(sourceRoot, 'doc/a.txt', 'payload');
    await put(targetRoot, 'a.txt', 'payload');
    const group = reportOf(await finder.scan(sourceRoot, targetRoot)).groups[0];
    assert.equal(group.adoptable, false);
    await assert.rejects(finder.adopt([group.hash]), /不可排除|零字节|硬链接|没有可排除/);
  }));

  console.log(`重复文件查找：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main().catch((e) => { console.error(e); process.exitCode = 1; });
