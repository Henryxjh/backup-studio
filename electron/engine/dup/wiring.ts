import { DuplicateFinder } from './index';
import type { WriteGate } from '../../../shared/types';

/**
 * 查重模块与备份主线的接线（FR-10、FR-20）。
 *
 * 单独抽成模块，是为了让「查重 → 备份」这条接缝**可以被测试直接覆盖**。
 *
 * 历史教训（P-03）：这条接缝曾经把抑制清单展开成备份侧的「排除名单」，
 * 连规范副本一起排除，导致整组内容**静默漏备份**（目标端一份都没写），
 * 并在严格镜像模式下挡住孤儿清理、目标端永不收敛。
 * 规格 §4.2 明确「与备份引擎的自动联动」不做，抑制只影响检测页的提示。
 *
 * 因此这里**只允许**注入删除所需的能力（回收站、闸门、忙闲、定位），
 * 不得出现任何「把查重结果喂给备份引擎」的通道。
 */
export interface DuplicateFinderWiring {
  /** 本机状态目录（抑制清单 / 隔离区 / 审计日志） */
  localDirectory: string;
  /** 备份引擎的写入闸门：介质异常一律拒绝删除 */
  writeGate: (root: string) => Promise<Pick<WriteGate, 'allowed' | 'reason'>>;
  /** 备份任务是否正在执行 */
  isBackupBusy: () => boolean;
  /** 自动同步是否正在执行 */
  isAutoSyncRunning: () => boolean;
  /** 系统回收站落地；抛错视为回收站不可用 → 引擎降级到本机隔离区（FR-08） */
  trash: (absPath: string) => Promise<void>;
  /** 在系统文件管理器中定位文件 */
  revealFile: (absPath: string) => void;
  /** 抑制清单变更回调（FR-12、FR-13） */
  onSuppressionsChanged?: (root: string, reason: string) => void;
}

/**
 * 按接线创建查重引擎。
 *
 * 刻意保持「单向依赖」：查重可以读备份引擎的闸门与忙闲状态，
 * 但备份引擎拿不到查重的任何结论。
 */
export function createDuplicateFinder(wiring: DuplicateFinderWiring): DuplicateFinder {
  return new DuplicateFinder(wiring.localDirectory, {
    trash: wiring.trash,
    gate: (root) => wiring.writeGate(root),
    isBusy: () => wiring.isBackupBusy() || wiring.isAutoSyncRunning(),
    revealFile: wiring.revealFile,
    onSuppressionsChanged: wiring.onSuppressionsChanged,
  });
}
