import { IconAlert } from './Icons';
import { fmtBytes, fmtInt } from '../lib/format';
import type { RecoverableJob } from '../../shared/types';

interface Props {
  job: RecoverableJob;
  busy: boolean;
  onRecover: () => void;
}

/**
 * 中断任务的常驻恢复卡。
 *
 * 只要引擎报告存在可恢复任务，这张卡就一直挂在界面上，
 * 不依赖任务当前处于哪个 phase —— 中断过一次的事，用户必须能随时找回。
 */
export function RecoverCard({ job, busy, onRecover }: Props) {
  return (
    <section className="recover-card" aria-label="可恢复的备份任务">
      <div className="recover-card-head">
        <IconAlert size={14} className="icon-inline" />
        <span>有中断未完成的备份</span>
      </div>
      <dl className="recover-card-grid">
        <div>
          <dt>源目录</dt>
          <dd>{job.sourceRoot}</dd>
        </div>
        <div>
          <dt>备份目标目录</dt>
          <dd>{job.targetRoot}</dd>
        </div>
        <div>
          <dt>剩余文件</dt>
          <dd>
            {fmtInt(job.remainingFiles)} 个
            {job.remainingBytes > 0 ? ` · ${fmtBytes(job.remainingBytes)}` : ''}
          </dd>
        </div>
        <div>
          <dt>中断原因</dt>
          <dd>{job.reason ?? '引擎未上报中断原因'}</dd>
        </div>
      </dl>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onRecover}>
        重新扫描并恢复中断的备份
      </button>
      <p className="recover-card-note">恢复会先重新扫描并生成新计划，旧的删除动作不会执行。</p>
    </section>
  );
}
