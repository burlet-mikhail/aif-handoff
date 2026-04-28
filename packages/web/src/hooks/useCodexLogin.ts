import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const CAPABILITIES_KEY = ["codex-login", "capabilities"] as const;
const STATUS_KEY = ["codex-login", "status"] as const;

export function useCodexLoginCapabilities() {
  return useQuery({
    queryKey: CAPABILITIES_KEY,
    queryFn: () => api.getCodexLoginCapabilities(),
    staleTime: 60_000,
  });
}

export function useCodexLoginStatus(
  options: { enabled?: boolean; pollIntervalMs?: number | false } = {},
) {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? false;
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.getCodexLoginStatus(),
    enabled,
    // Single fetch on first enable + explicit invalidation by start/cancel
    // mutations + interval polling while a session is in-flight. StrictMode
    // remounts and window-focus events must not drag the broker.
    refetchInterval: enabled && pollIntervalMs !== false ? pollIntervalMs : false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useStartCodexLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startCodexLogin(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useCancelCodexLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelCodexLogin(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
