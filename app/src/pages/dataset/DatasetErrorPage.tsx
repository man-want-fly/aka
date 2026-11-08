import { useEffect, useState } from "react";

import { maybeRunS080203 } from "../../features/dataset/s080203Diag";
import { describeError, ipc } from "../../lib/ipc";
import type { DatasetErrorCode, DatasetIntegrityDto } from "../../lib/types";

/** 各错误分类的用户可读说明（标题由后端随 DTO 返回，避免两处口径漂移）。 */
const DESCRIPTIONS: Record<DatasetErrorCode, string> = {
  MISSING_DIR: "应用找不到样本数据目录。可重建样本包恢复；重建需要写入磁盘。",
  MANIFEST_INVALID: "数据集描述文件（manifest）缺失或格式不合法，无法确认数据版本。",
  REQUIRED_TABLE_MISSING: "主数据 / 日线 / 复权 / 日历至少一张必需表不可用。",
  SHA256_MISMATCH: "数据内容与 manifest 摘要不一致，可能被改动或复制不完整。可只读浏览现有数据。",
  DB_CORRUPT: "数据文件部分损坏，仅可只读浏览可读部分，建议重建样本包。",
};

interface Props {
  integrity: DatasetIntegrityDto;
  /** 重跑校验；返回最新结果（App 负责据此关闭错误卡）。 */
  onRecheck: () => Promise<DatasetIntegrityDto>;
  /** 进入只读浏览（后端置只读门禁 + App 切到主界面）。 */
  onEnterReadonly: () => Promise<void>;
}

/**
 * S-08.02-03：启动校验失败的全屏错误卡。
 * 只展示错误码 / trace id / 数据集路径，不展示堆栈或原始异常。
 */
export function DatasetErrorPage({ integrity, onRecheck, onEnterReadonly }: Props) {
  const [rebuilding, setRebuilding] = useState(false);
  const [entering, setEntering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [traces, setTraces] = useState<string[]>([integrity.traceId]);

  // S-08.02-03 取证入口（仅 AKA_DIAG_TARGET=s080203）。
  useEffect(() => {
    void maybeRunS080203(integrity);
  }, [integrity]);

  const code = integrity.errorCode;
  const description = code ? DESCRIPTIONS[code] : "数据集校验未通过。";

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setHint(`${label}已复制`);
    } catch {
      setHint(`复制失败，请手动选择${label}`);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    setActionError(null);
    setHint(null);
    try {
      await ipc.datasetRegenerate();
      const next = await onRecheck();
      if (next.state !== "ok") {
        setTraces((prev) => [next.traceId, ...prev].slice(0, 3));
        setActionError(next.detail ?? "重建后校验仍未通过");
      }
      // 成功时 App 已切回主界面，本组件随之卸载。
    } catch (error) {
      const failure = describeError(error);
      setActionError(
        failure.message.includes("磁盘只读")
          ? `目录不可写：${integrity.datasetPath}`
          : failure.message,
      );
    } finally {
      setRebuilding(false);
    }
  };

  const exportDiagnostics = async () => {
    setHint(null);
    setActionError(null);
    try {
      const result = await ipc.exportDiagnostics({ dataset_id: integrity.datasetId });
      setHint(`诊断包已导出：${result.path}`);
    } catch (error) {
      setActionError(`导出失败：${describeError(error).message}`);
    }
  };

  const enterReadonly = async () => {
    setEntering(true);
    setActionError(null);
    try {
      await onEnterReadonly();
    } catch (error) {
      setActionError(describeError(error).message);
      setEntering(false);
    }
  };

  return (
    <div className="dataset-error" data-dataset-error={code ?? "UNKNOWN"} role="alert">
      <div className="dataset-error-card">
        <div className="dataset-error-head">
          <strong data-dataset-error-title>{integrity.title ?? "数据集校验未通过"}</strong>
          <code className="qa-code" data-dataset-error-code>
            {code ?? "UNKNOWN"}
          </code>
        </div>
        <p className="dataset-error-desc">{description}</p>
        {integrity.detail && <p className="dataset-error-detail">{integrity.detail}</p>}

        <dl className="dataset-error-meta">
          <dt>trace id</dt>
          <dd>
            <code data-dataset-error-trace>{traces[0]}</code>
            <button
              type="button"
              className="dataset-error-copy"
              data-dataset-copy-trace
              onClick={() => void copyText(traces[0], "trace id")}
            >
              复制
            </button>
          </dd>
          <dt>数据集路径</dt>
          <dd>
            <code data-dataset-error-path>{integrity.datasetPath}</code>
            <button
              type="button"
              className="dataset-error-copy"
              data-dataset-copy-path
              onClick={() => void copyText(integrity.datasetPath, "数据集路径")}
            >
              复制
            </button>
          </dd>
        </dl>

        {traces.length > 1 && (
          <p className="dataset-error-history" data-dataset-error-history>
            历史 trace：{traces.slice(1).join(" / ")}
          </p>
        )}

        <div className="dataset-error-actions">
          <button
            type="button"
            className="dataset-error-primary"
            data-dataset-rebuild
            disabled={rebuilding || entering}
            onClick={() => void rebuild()}
          >
            {rebuilding ? "重建中…" : "重建样本包"}
          </button>
          <button
            type="button"
            data-dataset-export
            disabled={rebuilding || entering}
            onClick={() => void exportDiagnostics()}
          >
            导出诊断
          </button>
          {integrity.readable && (
            <button
              type="button"
              data-dataset-readonly
              disabled={rebuilding || entering}
              onClick={() => void enterReadonly()}
            >
              {entering ? "进入中…" : "只读浏览"}
            </button>
          )}
        </div>

        {actionError && (
          <p className="dataset-error-action" data-dataset-action-error role="alert">
            {actionError}
          </p>
        )}
        {hint && (
          <p className="dataset-error-hint" data-dataset-hint>
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
