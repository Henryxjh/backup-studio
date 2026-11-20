import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createDurableDirectory, historyDir, manifestPath, metaDir, syncDirectory, syncFile,
} from './manifest';

/** One undo generation addressed by the durable job id. Entries are write-once across retries. */
export class BackupTransaction {
  private readonly history: string;
  private readonly previousManifest: string;

  constructor(readonly root: string, jobId: string, private readonly check: () => Promise<void>) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('备份事务标识无效');
    this.history = path.join(historyDir(root), jobId);
    this.previousManifest = path.join(metaDir(root), 'history-index', `${jobId}.json`);
  }

  async preserveManifest(): Promise<void> {
    await this.preserve(manifestPath(this.root), this.previousManifest);
  }

  async preserveTarget(file: string): Promise<void> {
    await this.preserve(file, path.join(this.history, path.relative(this.root, file)));
  }

  private async preserve(src: string, dest: string): Promise<void> {
    await this.check();
    const previous = await fs.lstat(dest).catch(ignoreMissing);
    if (previous) {
      if (!previous.isFile()) throw new Error('事务历史文件无效');
      await syncDirectory(path.dirname(dest));
      return;
    }
    const current = await fs.lstat(src).catch(ignoreMissing);
    if (!current) return;
    if (!current.isFile()) throw new Error(`目标路径不是普通文件：${src}`);
    await createDurableDirectory(path.dirname(dest), this.root);
    const tmp = `${dest}.tmp-${randomUUID()}`;
    try {
      await fs.copyFile(src, tmp, constants.COPYFILE_EXCL);
      await syncFile(tmp);
      const after = await fs.lstat(src);
      if (current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size ||
          current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
        throw new Error(`保存旧版本期间目标文件发生变化：${src}`);
      }
      await this.check();
      await fs.rename(tmp, dest);
      await syncDirectory(path.dirname(dest));
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async cleanup(): Promise<void> {
    await this.check();
    await fs.rm(this.history, { recursive: true, force: true });
    await this.check();
    await fs.unlink(this.previousManifest).catch(ignoreMissing);
    await syncDirectory(historyDir(this.root)).catch(ignoreMissing);
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): undefined {
  if (err.code !== 'ENOENT') throw err;
}
