import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  BarsResponse,
  CalcRequest,
  CalcResponse,
  GetBarsRequest,
  ManifestResponse,
  RegistryResponse,
  SecurityDto,
} from "./types";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function describeError(error: unknown): AppError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<AppError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: Boolean(candidate.retryable),
        details: candidate.details,
      };
    }
    if ("message" in error && typeof (error as Error).message === "string") {
      return {
        code: "INTERNAL",
        message: (error as Error).message,
        retryable: false,
      };
    }
  }
  return { code: "INTERNAL", message: String(error), retryable: false };
}

/** 前端唯一允许调用 Tauri 命令的出口。页面与组件禁止直接 import invoke。 */
export const ipc = {
  listSecurities: (limit = 200): Promise<SecurityDto[]> =>
    invoke<SecurityDto[]>("list_securities", {
      req: { market: "ALL", limit },
    }),

  getBars: (req: GetBarsRequest): Promise<BarsResponse> =>
    invoke<BarsResponse>("get_bars", { req }),

  indicatorRegistry: (category?: string): Promise<RegistryResponse> =>
    invoke<RegistryResponse>("indicator_registry", {
      req: { category: category ?? null },
    }),

  /** 指标目录唯一事实来源；生成指标列表/参数面板应优先用它。 */
  indicatorManifest: (): Promise<ManifestResponse> =>
    invoke<ManifestResponse>("indicator_manifest"),

  calcIndicators: (req: CalcRequest): Promise<CalcResponse> =>
    invoke<CalcResponse>("calc_indicators", { req }),
};
