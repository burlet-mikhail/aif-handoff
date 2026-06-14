import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useGitHubRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["github-repos"],
    queryFn: api.listGitHubRepos,
    enabled,
    staleTime: 60_000,
  });
}

export function useCloneRepo() {
  return useMutation({
    mutationFn: (input: { repoFullName: string; dirName?: string }) => api.cloneGitHubRepo(input),
  });
}

export function useGitPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rootPath: string) => api.gitPull(rootPath),
    onSuccess: (_, rootPath) => {
      // A pull can bring in new task files / change the tree — refresh the
      // import-status (drives the Import Tasks button visibility) and git state
      // so the UI reflects the new state without a manual page reload.
      qc.invalidateQueries({ queryKey: ["tasks-import-status"] });
      qc.invalidateQueries({ queryKey: ["git-status", rootPath] });
      qc.invalidateQueries({ queryKey: ["git-log", rootPath] });
    },
  });
}

export function useGitPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rootPath: string) => api.gitPush(rootPath),
    onSuccess: (_, rootPath) => {
      qc.invalidateQueries({ queryKey: ["git-status", rootPath] });
    },
  });
}

export function useGitFetch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rootPath: string) => api.gitFetch(rootPath),
    onSuccess: (_, rootPath) => {
      qc.invalidateQueries({ queryKey: ["git-branches", rootPath] });
      qc.invalidateQueries({ queryKey: ["git-status", rootPath] });
    },
  });
}

export function useGitStatus(rootPath: string | null) {
  return useQuery({
    queryKey: ["git-status", rootPath],
    queryFn: () => api.gitStatus(rootPath!),
    enabled: Boolean(rootPath),
    refetchInterval: 15_000,
  });
}

export function useGitLog(rootPath: string | null, limit = 20) {
  return useQuery({
    queryKey: ["git-log", rootPath, limit],
    queryFn: () => api.gitLog(rootPath!, limit),
    enabled: Boolean(rootPath),
  });
}

export function useGitBranches(rootPath: string | null) {
  return useQuery({
    queryKey: ["git-branches", rootPath],
    queryFn: () => api.gitBranches(rootPath!),
    enabled: Boolean(rootPath),
  });
}

export function useGitCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rootPath, branch }: { rootPath: string; branch: string }) =>
      api.gitCheckout(rootPath, branch),
    onSuccess: (_, { rootPath }) => {
      qc.invalidateQueries({ queryKey: ["git-status", rootPath] });
      qc.invalidateQueries({ queryKey: ["git-branches", rootPath] });
      qc.invalidateQueries({ queryKey: ["git-log", rootPath] });
    },
  });
}

export function useGitCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rootPath: string; message: string; files?: string[] }) =>
      api.gitCommit(input),
    onSuccess: (_, { rootPath }) => {
      qc.invalidateQueries({ queryKey: ["git-status", rootPath] });
      qc.invalidateQueries({ queryKey: ["git-log", rootPath] });
    },
  });
}
