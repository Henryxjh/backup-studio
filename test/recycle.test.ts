import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from '../electron/engine/service';
import { archivePath } from '../electron/engine/recycle';
import { readManifest } from '../electron/engine/manifest';
import { scanTree } from '../electron/engine/scan';
import { buildPlan } from '../electron/engine/planner';
import type { SyncMode } from '../shared/types';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function readFile(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function makeService(): Promise<BackupService> {
  return new BackupService(await makeTemp('backup-studio-recycle-journal-'));
}

async function runBackup(service: BackupService, source: string, target: string, syncMode: SyncMode): Promise<void> {
  await service.plan(source, target, syncMode);
  await service.start({
    sourceRoot: source,
    targetRoot: target,
    syncMode,
    allowMassDelete: true,
    resume: true,
  });
  assert.equal(service.getState().phase, 'completed', '备份应正常完成');
}

async function planFor(source: string, target: string, syncMode: SyncMode) {
  const [src, dst, manifest] = await Promise.all([
    scanTree(source),
    scanTree(target),
    readManifest(target),
  ]);
  return buildPlan({ sourceRoot: source, targetRoot: target, source: src, target: dst, manifest, syncMode });
}

async function main(): Promise<void> {
  console.log('\n备份回收站与非破坏性默认验证\n');

  await test('非破坏性模式：源端删除的文件在目标端原样保留，不产生删除动作', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'copy');

    await fs.unlink(path.join(source, 'gone.txt'));
    const plan = await planFor(source, target, 'copy');
    assert.equal(plan.summary.delete, 0, '非破坏性模式不应有删除动作');
    assert.equal(plan.summary.retained, 1, '多余文件应计入保留数');
    assert.equal(plan.actions.some((a) => a.type === 'delete'), false, '不应出现删除动作');
    assert.equal(plan.requiresConfirmation, false, '没有删除就不需要确认');
    const retained = plan.actions.find((a) => a.type === 'retain');
    assert.ok(retained, '应出现保留动作');
    assert.equal(retained?.relPath, 'gone.txt');

    await runBackup(service, source, target, 'copy');
    assert.equal(await exists(target, 'gone.txt'), true, '目标端多余文件必须保留');
    assert.equal(await readFile(target, 'gone.txt'), 'g', '保留的内容不得被改动');
  });

  await test('非破坏性模式：新增与更新照常执行', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'a.txt', 'a1');
    await runBackup(service, source, target, 'copy');

    await writeFile(source, 'a.txt', 'a2');
    await writeFile(source, 'b.txt', 'b1');
    await runBackup(service, source, target, 'copy');

    assert.equal(await readFile(target, 'a.txt'), 'a2', '变更内容应被更新');
    assert.equal(await readFile(target, 'b.txt'), 'b1', '新增文件应被复制');
  });

  await test('非破坏性模式：被保留的文件不写进备份清单', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'a.txt', 'a');
    await writeFile(source, 'b.txt', 'b');
    await runBackup(service, source, target, 'copy');

    await fs.unlink(path.join(source, 'a.txt'));
    await runBackup(service, source, target, 'copy');

    const manifest = await readManifest(target);
    assert.ok(manifest, '清单应存在');
    assert.equal(manifest?.files['a.txt'], undefined, '保留的文件不是本次备份内容，不应进清单');
    assert.ok(manifest?.files['b.txt'], '正常备份的文件应在清单里');
  });

  await test('删除闸门：删掉 1 个文件即要求确认，不再受 30% 孤儿率门槛限制', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    for (let i = 0; i < 100; i += 1) {
      await writeFile(source, `f${i}.txt`, `x${i}`);
    }
    await runBackup(service, source, target, 'mirror');

    await fs.unlink(path.join(source, 'f0.txt'));
    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.delete, 1, '应识别出 1 个待删除文件');
    // 旧门槛：孤儿率 1/100 = 1%，远低于 30%，会静默通过。
    assert.equal(plan.requiresConfirmation, true, '只要有删除就必须让用户确认');
    assert.match(plan.confirmReason, /1 个文件/, '确认原因应说明删除数量');
  });

  await test('安全镜像：删除的内容进入回收站，可还原且内容一致', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');
    assert.equal(await exists(target, 'gone.txt'), false, '原位置应被删除');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 1, '回收站应有一条记录');
    assert.equal(bin.entries[0].relPath, 'gone.txt');
    assert.equal(bin.entries[0].size, 1);
    assert.equal(bin.totalBytes, 1);
    assert.ok(bin.entries[0].deletedAt > 0, '应记录删除时间');

    const restored = await service.restoreRecycleEntry(target, bin.entries[0].id, false);
    assert.equal(restored.entries.length, 0, '还原后条目应从回收站移除');
    assert.equal(await readFile(target, 'gone.txt'), 'g', '还原内容必须与原文件一致');
  });

  await test('安全镜像：目标位置被占用时拒绝还原，显式覆盖后才写入', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'old');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const entry = bin.entries[0];
    assert.ok(entry, '应有回收项');
    await writeFile(target, 'gone.txt', 'new');

    await assert.rejects(
      () => service.restoreRecycleEntry(target, entry!.id, false),
      /已被占用/,
      '未确认覆盖时必须拒绝',
    );
    assert.equal(await readFile(target, 'gone.txt'), 'new', '被拒绝的还原不得改动目标端');

    await service.restoreRecycleEntry(target, entry!.id, true);
    assert.equal(await readFile(target, 'gone.txt'), 'old', '确认覆盖后应写回归档内容');
  });

  await test('安全镜像：彻底删除回收项后归档副本一并消失', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const entry = bin.entries[0];
    assert.ok(entry, '应有回收项');
    const archived = archivePath(target, entry!);
    assert.equal(await exists(path.dirname(archived), 'gone.txt'), true, '归档副本应存在');

    const after = await service.removeRecycleEntry(target, entry!.id);
    assert.equal(after.entries.length, 0, '条目应被移除');
    assert.equal(await exists(path.dirname(archived), 'gone.txt'), false, '归档副本应被彻底删除');
  });

  await test('严格镜像：删除的内容不进回收站，不可恢复', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror');
    assert.equal(await exists(target, 'gone.txt'), false, '严格镜像应删除目标端文件');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 0, '严格镜像不留副本，回收站应为空');
  });

  await test('回收站：目标位置与参数非法时明确报错', async () => {
    const service = await makeService();
    await assert.rejects(() => service.listRecycleBin(''), /无效/, '空路径应被拒绝');
    await assert.rejects(() => service.listRecycleBin('relative/path'), /无效/, '相对路径应被拒绝');
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
