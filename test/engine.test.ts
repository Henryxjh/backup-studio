import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTree } from '../electron/engine/scan';
import { buildPlan } from '../electron/engine/planner';
import { readManifest } from '../electron/engine/manifest';
import { CopyPool } from '../electron/engine/pool';
import { BackupService } from '../electron/engine/service';
import { assessMedia, identifyMedia, probeMedia, sameMedia } from '../electron/engine/media';
import { JournalStore, crc32, partFileName } from '../electron/engine/journal';
import type { MediaIdentity, SyncMode } from '../shared/types';

const WORKER_PATH = path.join(process.cwd(), 'dist-electron', 'electron', 'engine', 'copyWorker.js');

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

let bigSourceCache: string | null = null;
/**
 * 共享的大文件源目录（128 MB）。
 *
 * 两个掉盘用例共用，避免每次重复写 128 MB。
 * 体积必须足够大：复制要能在「拔盘」动作发生时仍处于进行中，
 * 否则备份会先跑完，根本测不到掉线。
 */
async function getBigSource(): Promise<string> {
  if (!bigSourceCache) {
    const dir = await makeTemp('bs-big-src-');
    await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.alloc(128 * 1024 * 1024, 7));
    bigSourceCache = dir;
  }
  return bigSourceCache;
}

/**
 * 等待复制真正开始：目标端 .part 已生成且仍在增长。
 *
 * 只看「.part 出现」不够——它可能一创建就写完，或复制已进入校验/提交阶段；
 * 必须确认文件仍在增长，才说明此刻确实处于写入过程中。
 */
async function waitForCopyInFlight(target: string): Promise<boolean> {
  const partDir = path.join(target, '.backup-studio', 'parts');
  for (let i = 0; i < 400; i += 1) {
    const names = await fs.readdir(partDir).catch(() => [] as string[]);
    if (names.length > 0) {
      const partPath = path.join(partDir, names[0]);
      const size = await fs.stat(partPath).then((s) => s.size).catch(() => 0);
      if (size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const size2 = await fs.stat(partPath).then((s) => s.size).catch(() => 0);
        if (size2 > size) return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
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

async function planFor(source: string, target: string, syncMode: SyncMode = 'mirror') {
  const [src, dst, manifest] = await Promise.all([
    scanTree(source),
    scanTree(target),
    readManifest(target),
  ]);
  return buildPlan({ sourceRoot: source, targetRoot: target, source: src, target: dst, manifest, syncMode });
}

async function runService(source: string, target: string, syncMode: SyncMode = 'mirror'): Promise<void> {
  const service = new BackupService(await makeTemp('backup-studio-journal-'));
  await service.plan(source, target, syncMode);
  await service.start({
    sourceRoot: source,
    targetRoot: target,
    syncMode,
    allowMassDelete: true,
    resume: true,
  });
}

async function main(): Promise<void> {
  console.log('\nBackup Studio 引擎验证\n');

  await test('首次备份：新增文件被完整复制', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    await writeFile(source, 'doc/b.txt', 'world');

    const plan = await planFor(source, target);
    assert.equal(plan.summary.copy, 2);
    assert.equal(plan.summary.skip, 0);

    await runService(source, target);
    assert.equal(await readFile(target, 'a.txt'), 'hello');
    assert.equal(await readFile(target, 'doc/b.txt'), 'world');
  });

  await test('二次备份：内容一致的文件被跳过，不重复拷贝', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    await writeFile(source, 'doc/b.txt', 'world');
    await runService(source, target);

    const plan = await planFor(source, target);
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.update, 0);
    assert.equal(plan.summary.skip, 2);
  });

  await test('路径变更：识别为改名，目标端同步移动且不复制内容', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'payload-unchanged');
    await runService(source, target);

    // 源端改名：a.txt -> doc/a.txt
    await fs.mkdir(path.join(source, 'doc'), { recursive: true });
    await fs.rename(path.join(source, 'a.txt'), path.join(source, 'doc/a.txt'));

    const plan = await planFor(source, target);
    assert.equal(plan.summary.rename, 1, '应识别为改名');
    assert.equal(plan.summary.copy, 0, '改名不应触发拷贝');
    assert.equal(plan.summary.delete, 0, '旧路径不应被判定为待删除');

    await runService(source, target);
    assert.equal(await exists(target, 'doc/a.txt'), true, '新路径应存在');
    assert.equal(await exists(target, 'a.txt'), false, '旧路径应被清除');
    assert.equal(await readFile(target, 'doc/a.txt'), 'payload-unchanged');
  });

  await test('内容变更：判定为更新并覆盖写入', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'v1');
    await runService(source, target);

    await writeFile(source, 'a.txt', 'v2-longer-content');
    const plan = await planFor(source, target);
    assert.equal(plan.summary.update, 1);
    assert.equal(plan.summary.copy, 0);

    await runService(source, target);
    assert.equal(await readFile(target, 'a.txt'), 'v2-longer-content');
  });

  await test('严格镜像：源端已删除的文件在目标端被删除', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runService(source, target);

    await fs.unlink(path.join(source, 'gone.txt'));
    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.delete, 1);

    await runService(source, target, 'mirror');
    assert.equal(await exists(target, 'gone.txt'), false);
    assert.equal(await exists(target, 'keep.txt'), true);
  });

  await test('镜像并保留历史：被删除的文件归档到历史目录', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runService(source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runService(source, target, 'mirror-archive');

    assert.equal(await exists(target, 'gone.txt'), false, '原位置不应保留');
    const historyRoot = path.join(target, '.backup-studio', 'history');
    const stamped = await fs.readdir(historyRoot);
    assert.equal(stamped.length, 1, '应生成一份历史归档');
    const archived = await fs.readFile(path.join(historyRoot, stamped[0], 'gone.txt'), 'utf8');
    assert.equal(archived, 'g', '归档内容应保持原样');
  });

  await test('断点续传：从 .part 偏移继续，产物与源文件逐字节一致', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    await fs.writeFile(path.join(source, 'big.bin'), payload);

    const partsDir = path.join(target, '.backup-studio', 'parts');
    await fs.mkdir(partsDir, { recursive: true });
    const partPath = path.join(partsDir, 'big.bin.part');
    // 模拟上次中断：已写入前 1 MiB
    await fs.writeFile(partPath, payload.subarray(0, 1024 * 1024));

    const pool = new CopyPool(WORKER_PATH, 2, {});
    const result = await new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
      pool.submit(
        {
          id: 'big.bin',
          srcPath: path.join(source, 'big.bin'),
          partPath,
          totalBytes: payload.length,
          verify: true,
        },
        {
          onDone: resolve,
          onError: (_id, error) => reject(new Error(error.message)),
        },
      );
    });
    await pool.destroy();

    const written = await fs.readFile(partPath);
    assert.equal(written.length, payload.length, '续传后长度应完整');
    assert.ok(written.equals(payload), '续传后内容应与源文件逐字节一致');
    const digest = createHash('sha256').update(payload).digest('hex');
    assert.equal(result.sha256, digest, '续传后的整体摘要应与源文件一致');
  });

  await test('B3：显式恢复只重写损坏、截断和缺失的分片', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const userData = await makeTemp('bs-journal-');
    const chunk = 1 << 20; // production default
    const tail = 123;
    const relPath = 'big.bin';
    const payload = Buffer.alloc(4 * chunk + tail, 0x5a);
    const partPath = path.join(target, '.backup-studio', 'parts', partFileName(relPath));
    await fs.writeFile(path.join(source, relPath), payload);
    await fs.mkdir(path.dirname(partPath), { recursive: true });
    // #0 and #2 are intact, #1 has a same-length hole, #3 is truncated, #4 is absent.
    const partial = Buffer.from(payload.subarray(0, 3 * chunk + 19));
    partial.fill(0, chunk, 2 * chunk);
    await fs.writeFile(partPath, partial);

    const store = new JournalStore(userData);
    const timestamp = Date.now();
    await store.write({
      version: 1,
      jobId: 'b3-recovery',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: timestamp,
      updatedAt: timestamp,
      txSeq: 1,
      committedTx: 1,
      mediaIdentity: (await identifyMedia(target)) ?? undefined,
      interruption: { at: timestamp, reason: '模拟掉盘', activeFiles: [relPath], committedTasks: 0 },
      tasks: {
        [relPath]: {
          relPath, totalBytes: payload.length, copiedBytes: payload.length, partPath, status: 'copying',
        },
      },
    });
    await store.setActive('b3-recovery');

    const service = new BackupService(userData);
    const copies: import('../electron/engine/pool').CopyResult[] = [];
    service.on('copy-completed', (result) => copies.push(result));
    await service.recover({ confirmed: true });

    assert.equal(service.getState().phase, 'completed');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].id, relPath);
    assert.deepEqual(copies[0].writtenChunks, [
      { index: 1, offset: chunk, bytesWritten: chunk },
      { index: 3, offset: 3 * chunk, bytesWritten: chunk },
      { index: 4, offset: 4 * chunk, bytesWritten: tail },
    ]);
    assert.equal(copies[0].writtenBytes, 2 * chunk + tail);
    const final = await fs.readFile(path.join(target, relPath));
    assert.ok(final.equals(payload));
    assert.equal(copies[0].sha256, createHash('sha256').update(payload).digest('hex'));
  });

  await test('多线程复制：并发写入的文件全部校验通过', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    for (let i = 0; i < 12; i += 1) {
      await writeFile(source, `f${i}.bin`, `payload-${i}-${'x'.repeat(1000 + i)}`);
    }
    await runService(source, target);
    for (let i = 0; i < 12; i += 1) {
      assert.equal(await readFile(target, `f${i}.bin`), `payload-${i}-${'x'.repeat(1000 + i)}`);
    }
  });

  await test('拔盘检测：备份过程中目标介质掉线，介质状态转为 lost', async () => {
    const source = await getBigSource();
    const target = await makeTemp('bs-dst-');

    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');
    const running = service.start({
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    // 必须等到复制确实在进行中再去「拔盘」。若复制先跑完，备份已经结束，
    // 介质状态不会变成 lost——那不是掉线检测的失败，而是模拟时序的失败。
    assert.ok(await waitForCopyInFlight(target), '复制应已进入进行中状态');

    // 模拟介质被拔出
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

    let state = service.getState();
    for (let i = 0; i < 60 && state.media !== 'lost'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = service.getState();
      if (process.env.BS_TRACE) {
        console.log(`   [trace] i=${i} media=${state.media} phase=${state.phase}`);
      }
    }
    assert.equal(state.media, 'lost', '介质不可达时状态应为 lost');

    service.cancel();
    await running.catch(() => undefined);
  });

  await test('容灾：掉线后不再向目标盘写入，也不会重建目标目录', async () => {
    const source = await getBigSource();
    const target = await makeTemp('bs-dst-');

    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');
    const running = service.start({
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    assert.ok(await waitForCopyInFlight(target), '复制应已进入进行中状态');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

    let state = service.getState();
    for (let i = 0; i < 60 && state.media !== 'lost'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = service.getState();
    }
    assert.equal(state.media, 'lost', '介质不可达时状态应为 lost');

    // 关键回归：引擎**不得**把目标目录重新创建出来。
    // 账本镜像双写（writeMirror 先 mkdir）与提交产物（先 mkdir 再 rename）
    // 都会在目标端创建目录。若掉线后仍执行，只读探测就会把这个自己造出来的
    // 目录当成「介质可达」，把 lost 悄悄翻回 online——掉线事实被彻底掩盖。
    assert.equal(
      await exists(target, '.'),
      false,
      '掉线后不得重建目标目录（否则会把掉线掩盖为介质正常）',
    );

    // 再观察一段时间，确认后续没有写入把目录重建回来
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await exists(target, '.'), false, '掉线后一段时间内不得重建目标目录');
    assert.equal(service.getState().media, 'lost', '掉线状态不得被自行翻回 online');

    service.cancel();
    await running.catch(() => undefined);
  });

  await test('容灾：只读探测不创建任何目录（探测阶段不得有写副作用）', async () => {
    const target = await makeTemp('bs-probe-');
    const probe = await probeMedia(target);
    assert.equal(probe.reachable, true, '存在的目录应判定为可达');
    assert.equal(probe.writable, true);
    // 探测不得在目标端创建 .backup-studio 或任何其他目录
    const entries = await fs.readdir(target);
    assert.deepEqual(entries, [], `探测后目标目录应为空，实际为 ${JSON.stringify(entries)}`);
  });

  await test('容灾：不存在的路径探测为不可达且不抛异常', async () => {
    const missing = path.join(await makeTemp('bs-gone-'), 'not-exist');
    const probe = await probeMedia(missing);
    assert.equal(probe.reachable, false);
    assert.equal(probe.writable, false);
    assert.equal(probe.identity, null);
  });

  await test('容灾：介质身份可识别且同一路径比对稳定', async () => {
    const target = await makeTemp('bs-ident-');
    const a = await identifyMedia(target);
    const b = await identifyMedia(target);
    assert.equal(sameMedia(a, b), true, '同一目录两次识别应一致');
    assert.ok(a.dev.length > 0 && a.ino.length > 0 && a.birth.length > 0, '身份字段应非空');
  });

  await test('容灾：介质身份漂移判定为 L2 并禁止写入', async () => {
    const target = await makeTemp('bs-drift-');
    const real = await identifyMedia(target);
    const fake: MediaIdentity = { dev: '999', ino: '888', birth: '777' };
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: fake,
      manifestReadable: true,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L2', '身份不一致必须判为 L2');
    assert.equal(assessment.writable, false, 'L2 不得允许写入');
    assert.ok(assessment.evidence.length > 0, '判定必须附证据链');
    assert.ok(
      assessment.evidence.some((e) => e.kind === '介质身份'),
      '证据链应包含介质身份项',
    );
    void real;
  });

  await test('容灾：不可达介质判定为 L2', async () => {
    const missing = path.join(await makeTemp('bs-lost-'), 'not-exist');
    const probe = await probeMedia(missing);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: false,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L2');
    assert.equal(assessment.writable, false);
  });

  await test('容灾：证据不足时默认 L1 只读，不自动写盘', async () => {
    const target = await makeTemp('bs-l1-');
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: false,
      ioErrors: 1,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L1', '不确定时应默认 L1');
    assert.equal(assessment.writable, false, 'L1 不得自动写盘');
  });

  await test('容灾：隔离状态下即使介质正常也判为 L2', async () => {
    const target = await makeTemp('bs-quar-');
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: true,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: true,
    });
    assert.equal(assessment.level, 'L2', '已隔离必须判为 L2');
    assert.equal(assessment.writable, false);
  });

  await test('容灾：事务日志可检测盘上副本被截断（CRC 不匹配）', async () => {
    const target = await makeTemp('bs-mirror-');
    const store = new JournalStore(await makeTemp('bs-jrn-'));
    const job = {
      version: 1 as const,
      jobId: 'job-1',
      sourceRoot: 'C:\\src',
      targetRoot: target,
      syncMode: 'mirror' as SyncMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 3,
      committedTx: 3,
      tasks: {
        'a.txt': {
          relPath: 'a.txt',
          totalBytes: 10,
          copiedBytes: 10,
          partPath: 'p',
          status: 'done' as const,
          sha256: 'abc',
        },
      },
    };
    // 生产流程中 start() 会先建好目标端元数据目录；镜像写入**不会**自己创建目录
    // （介质掉线后建目录会把目标端「造回来」，掩盖掉线事实）。
    await fs.mkdir(path.join(target, '.backup-studio'), { recursive: true });
    const ok = await store.writeMirror(target, job);
    assert.equal(ok, true, '盘上镜像日志应写入成功');

    const read = await store.readMirror(target);
    assert.ok(read, '盘上镜像日志应可读');
    assert.equal(read.txSeq, 3);
    assert.equal(read.tasks['a.txt'].copiedBytes, 10);

    // 模拟盘上日志被截断/损坏
    const mirrorPath = path.join(target, '.backup-studio', 'journal-mirror.json');
    const raw = await fs.readFile(mirrorPath, 'utf8');
    await fs.writeFile(mirrorPath, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
    const broken = await store.readMirror(target);
    assert.equal(broken, null, '损坏或截断的盘上日志必须被识别出来，而不是当作有效数据');
  });

  await test('容灾：CRC32 对相同内容稳定且对改动敏感', () => {
    assert.equal(crc32('hello'), crc32('hello'));
    assert.notEqual(crc32('hello'), crc32('hellp'));
  });

  await test('容灾：本机账本在介质不可用时仍可读出断点', async () => {
    const userData = await makeTemp('bs-jrn-');
    const store = new JournalStore(userData);
    const job = {
      version: 1 as const,
      jobId: 'job-2',
      sourceRoot: 'C:\\src',
      targetRoot: 'E:\\gone',
      syncMode: 'mirror' as SyncMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 5,
      committedTx: 4,
      interruption: {
        at: Date.now(),
        reason: '模拟掉盘',
        activeFiles: ['big.bin'],
        committedTasks: 1,
      },
      tasks: {
        'big.bin': {
          relPath: 'big.bin',
          totalBytes: 1000,
          copiedBytes: 400,
          partPath: 'p',
          status: 'copying' as const,
        },
      },
    };
    await store.write(job);
    await store.setActive('job-2');

    // 目标路径已不存在，但本机账本必须完好
    const active = await store.getActive();
    assert.ok(active, '本机账本应可读');
    assert.ok(active?.interruption, '中断标记应保存在本机');
    assert.deepEqual(active?.interruption?.activeFiles, ['big.bin']);
    assert.equal(active?.tasks['big.bin'].copiedBytes, 400, '断点字节数应完整保留');
  });

  await test('容灾：隔离标记可撤销，撤销后允许重新备份', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');

    const mark = await service.quarantine(target, '测试隔离');
    assert.equal(mark.released, false);
    assert.equal(mark.level, 'L2');
    assert.equal(service.getState().media, 'quarantined');

    // 隔离未撤销时禁止写入
    await assert.rejects(
      () =>
        service.start({
          sourceRoot: source,
          targetRoot: target,
          syncMode: 'mirror',
          allowMassDelete: true,
          resume: true,
        }),
      /隔离/,
      '隔离状态下应拒绝开始备份',
    );

    await service.releaseQuarantine();
    assert.equal(service.getState().quarantine?.released, true, '隔离标记应可撤销');
    assert.equal(service.getState().media, 'online');
  });

  await test('容灾：中断后旧计划失效，必须重新扫描才能开始', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');

    // 直接触发中断路径：写入账本中断记录
    const anyService = service as unknown as {
      currentJob: unknown;
      handleMediaLoss: (msg: string) => Promise<void>;
      currentPlan: unknown;
    };
    anyService.currentJob = {
      version: 1,
      jobId: 'j1',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 0,
      committedTx: 0,
      tasks: {},
    };
    await anyService.handleMediaLoss('模拟掉盘');

    assert.equal(anyService.currentPlan, null, '中断后旧计划必须失效');
    assert.equal(service.getState().media, 'lost');

    // 中断记录存在时，start 应拒绝沿用旧计划
    await assert.rejects(
      () =>
        service.start({
          sourceRoot: source,
          targetRoot: target,
          syncMode: 'mirror',
          allowMassDelete: true,
          resume: true,
        }),
      /重新扫描|隔离/,
      '中断后应要求重新扫描',
    );
  });

  await test('高风险删除闸门：源端为空时不静默清空目标', async () => {    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'a');
    await writeFile(source, 'b.txt', 'b');
    await runService(source, target);

    // 清空源端
    await fs.rm(path.join(source, 'a.txt'));
    await fs.rm(path.join(source, 'b.txt'));

    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.requiresConfirmation, true, '应要求用户二次确认');
    assert.ok(plan.confirmReason.length > 0);
  });

  await test('稳定性：同尺寸但 mtime 变动且内容一致的文件实算目标哈希后判定跳过', async () => {
    const source = await makeTemp('bs-same-src-');
    const target = await makeTemp('bs-same-dst-');
    await writeFile(source, 'doc.bin', 'SAME-CONTENT-8B');
    await writeFile(target, 'doc.bin', 'SAME-CONTENT-8B');
    const older = new Date(1700000000000);
    const newer = new Date(1700000020000);
    await fs.utimes(path.join(target, 'doc.bin'), older, older);
    await fs.utimes(path.join(source, 'doc.bin'), newer, newer);

    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.skip, 1, '同内容文件应直接跳过而非重传');
    assert.equal(plan.summary.update, 0, '同内容不应误判为 update');
    assert.equal(plan.summary.bytes, 0);
  });

  await test('可靠性：超过 20000 条动作时 UI 预览截断但后台完整执行不漏文件', async () => {
    const fakeFiles = new Map<string, { relPath: string; size: number; mtimeMs: number }>();
    for (let i = 0; i < 20005; i += 1) {
      fakeFiles.set(`f${i}.txt`, { relPath: `f${i}.txt`, size: 1, mtimeMs: 1000 });
    }
    const plan = await buildPlan({
      sourceRoot: '/tmp/fake-src',
      targetRoot: '/tmp/fake-dst',
      source: { root: '/tmp/fake-src', files: fakeFiles, dirs: [], totalBytes: 20005, skippedSymlinks: 0, errors: [] },
      target: { root: '/tmp/fake-dst', files: new Map(), dirs: [], totalBytes: 0, skippedSymlinks: 0, errors: [] },
      manifest: null,
      syncMode: 'mirror',
    });
    assert.equal(plan.actions.length, 20005, '执行动作不可截断');
    assert.equal(plan.previewActions.length, 20000, '预览列表应限制在 20000 条');
    assert.equal(plan.truncated, true);
  });

  await test('可靠性：单文件复制失败时不允许报 completed 且保留断点供恢复', async () => {
    const source = await makeTemp('bs-fail-src-');
    const target = await makeTemp('bs-fail-dst-');
    const userData = await makeTemp('bs-fail-ud-');
    await writeFile(source, 'ok.txt', 'good');
    await writeFile(source, 'missing.txt', 'will-vanish');

    const service = new BackupService(userData);
    await service.plan(source, target, 'mirror');
    // 在开始前删掉其中一个源文件，触发单文件失败
    await fs.unlink(path.join(source, 'missing.txt'));

    await service.start({
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    const state = service.getState();
    assert.equal(state.phase, 'failed', '存在失败动作时 phase 不得伪装成 completed');
    assert.equal(await fs.readFile(path.join(target, 'ok.txt'), 'utf8'), 'good');
    const rec = await service.findRecoverableJob();
    assert.ok(rec !== null, '部分失败应保留活动断点指针');
  });

  await test('容灾：recover() 在重新扫描失败时不提前丢失旧断点指针', async () => {
    const source = await makeTemp('bs-rec-src-');
    const target = await makeTemp('bs-rec-dst-');
    const userData = await makeTemp('bs-rec-ud-');
    await writeFile(source, 'a.txt', 'hello');

    const service = new BackupService(userData);
    const store = new JournalStore(userData);
    await store.write({
      version: 1,
      jobId: 'keep-active-on-plan-fail',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 1,
      committedTx: 1,
      mediaIdentity: await identifyMedia(target),
      interruption: { at: Date.now(), reason: '模拟中断', activeFiles: ['a.txt'], committedTasks: 0 },
      tasks: {
        'a.txt': {
          relPath: 'a.txt',
          totalBytes: 5,
          copiedBytes: 0,
          partPath: path.join(target, '.backup-studio', 'parts', partFileName('a.txt')),
          status: 'copying',
        },
      },
    });
    await store.setActive('keep-active-on-plan-fail');

    // 删除源目录使 recover 中的 plan() 失败
    await fs.rm(source, { recursive: true, force: true });
    await assert.rejects(() => service.recover({ confirmed: true }));
    const stillThere = await service.findRecoverableJob();
    assert.equal(stillThere?.jobId, 'keep-active-on-plan-fail', 'recover 失败后旧 active 指针应完整保留');
  });

  await test('可靠性：源端同名 .backup-studio 目录不被漏备、空目录同步、嵌套目录被拦截', async () => {
    const source = await makeTemp('bs-meta-src-');
    const target = await makeTemp('bs-meta-dst-');
    const userData = await makeTemp('bs-meta-ud-');
    await writeFile(source, '.backup-studio/user-file.txt', 'preserve-me');
    await fs.mkdir(path.join(source, 'empty-dir'), { recursive: true });

    const service = new BackupService(userData);
    await service.plan(source, target, 'mirror');
    await service.start({
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });
    assert.equal(service.getState().phase, 'completed');
    assert.equal(await fs.readFile(path.join(target, '.backup-studio', 'user-file.txt'), 'utf8'), 'preserve-me');
    const emptyStat = await fs.stat(path.join(target, 'empty-dir'));
    assert.equal(emptyStat.isDirectory(), true, '源端空目录应同步到目标端');

    // 嵌套目录校验
    const nestedTarget = path.join(source, 'nested-dst');
    await fs.mkdir(nestedTarget, { recursive: true });
    await assert.rejects(() => service.plan(source, nestedTarget, 'mirror'), /不能位于源目录内部/);
    await assert.rejects(() => service.plan(source, source, 'mirror'), /同一路径/);
  });

  await test('可靠性：孤儿文件哈希读取失败时不进入删除列表', async () => {
    const source = await makeTemp('bs-orpha-src-');
    const target = await makeTemp('bs-orpha-dst-');
    await writeFile(source, 'new-name.txt', '123456');
    await writeFile(target, 'old-name.txt', '123456');

    const srcScan = await scanTree(source, { excludeMetaDir: false });
    const dstScan = await scanTree(target, { excludeMetaDir: true });
    // 删除 target 上的 old-name.txt 模拟规划期间哈希阶段读取失败（权限拒绝/I/O 错误等）
    await fs.unlink(path.join(target, 'old-name.txt'));

    const plan = await buildPlan({
      sourceRoot: source,
      targetRoot: target,
      source: srcScan,
      target: dstScan,
      manifest: null,
      syncMode: 'mirror',
    });
    assert.ok(plan.hashErrors.length > 0, '应记录哈希读取错误');
    assert.equal(
      plan.actions.some((a) => a.type === 'delete' && a.relPath === 'old-name.txt'),
      false,
      '哈希失败的孤儿文件严禁生成删除动作',
    );
  });

  if (process.platform === 'win32') {
    await test('Windows 大小写变更：并发拷贝与大量删除不误删仅大小写变化的源端文件', async () => {
      const source = await makeTemp('bs-case-src-');
      const target = await makeTemp('bs-case-dst-');
      const userData = await makeTemp('bs-case-ud-');
      await writeFile(source, 'zzz_target.txt', 'MUST-SURVIVE');
      await writeFile(target, 'ZZZ_TARGET.txt', 'old-small');
      for (let i = 0; i < 60; i += 1) {
        await writeFile(target, `aaa_del_${String(i).padStart(2, '0')}.txt`, 'x');
      }

      const service = new BackupService(userData);
      await service.plan(source, target, 'mirror');
      await service.start({
        sourceRoot: source,
        targetRoot: target,
        syncMode: 'mirror',
        allowMassDelete: true,
        resume: true,
      });
      assert.equal(service.getState().phase, 'completed');
      assert.equal(await fs.readFile(path.join(target, 'zzz_target.txt'), 'utf8'), 'MUST-SURVIVE');
    });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
