import { useCallback, useEffect, useState } from "react";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { IndicatorFavoriteDto } from "../../lib/types";

const MIN_BUSY_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** S-03.02-01：收藏列表；首次读取由后端写入默认 8 项。 */
export function useFavorites(enabled: boolean) {
  const [favorites, setFavorites] = useState<IndicatorFavoriteDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) {
      setFavorites([]);
      return;
    }
    try {
      const response = await ipc.indicatorFavorites();
      setFavorites(response.favorites);
      setError(null);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const toggle = useCallback(
    async (indicatorId: string, favorited: boolean) => {
      if (!isTauriRuntime() || busyId) return;
      setBusyId(indicatorId);
      try {
        const [response] = await Promise.all([
          ipc.setIndicatorFavorite(indicatorId, favorited),
          sleep(MIN_BUSY_MS),
        ]);
        setFavorites(response.favorites);
        setError(null);
      } catch (err) {
        setError(describeError(err).message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  return { favorites, busyId, error, toggle, refresh };
}
