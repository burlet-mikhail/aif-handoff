import { useState, useMemo } from "react";
import {
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ChevronDown,
  FileEdit,
  FilePlus,
  FileCheck,
  Loader2,
  Upload,
  ListTodo,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  useGitStatus,
  useGitLog,
  useGitBranches,
  useGitCheckout,
  useGitCommit,
  useGitPull,
  useGitPush,
  useGitFetch,
} from "@/hooks/useGitHub";
import { useTasks } from "@/hooks/useTasks";
import type { Project } from "@aif/shared/browser";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  initialCommitMsg?: string;
}

type Tab = "status" | "log" | "branches";

export function GitPanel({ open, onOpenChange, project, initialCommitMsg }: Props) {
  const rootPath = project?.rootPath ?? null;
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("status");
  const [commitMsg, setCommitMsg] = useState(initialCommitMsg ?? "");

  const {
    data: status,
    isLoading: statusLoading,
    refetch: refetchStatus,
  } = useGitStatus(open ? rootPath : null);
  const { data: logEntries, isLoading: logLoading } = useGitLog(
    open && tab === "log" ? rootPath : null,
  );
  const { data: branchData, isLoading: branchesLoading } = useGitBranches(
    open && tab === "branches" ? rootPath : null,
  );

  const { data: tasks } = useTasks(open ? (project?.id ?? null) : null);
  const activeTasks = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => t.status !== "done" && t.status !== "verified" && t.status !== "backlog",
      ),
    [tasks],
  );
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);

  const gitPull = useGitPull();
  const gitPush = useGitPush();
  const gitFetch = useGitFetch();
  const gitCheckout = useGitCheckout();
  const gitCommit = useGitCommit();

  const handlePull = () => {
    if (!rootPath) return;
    gitPull.mutate(rootPath, {
      onSuccess: (r) => {
        toast(r.output || "Already up to date", "success", 5000);
        refetchStatus();
      },
      onError: (err) => toast(err instanceof Error ? err.message : "Pull failed", "error", 8000),
    });
  };

  const handleFetch = () => {
    if (!rootPath) return;
    gitFetch.mutate(rootPath, {
      onSuccess: (r) => toast(r.output || "Fetched", "success", 5000),
      onError: (err) => toast(err instanceof Error ? err.message : "Fetch failed", "error", 8000),
    });
  };

  const handleCheckout = (branch: string) => {
    if (!rootPath) return;
    gitCheckout.mutate(
      { rootPath, branch },
      {
        onSuccess: () => toast(`Switched to ${branch}`, "success"),
        onError: (err) =>
          toast(err instanceof Error ? err.message : "Checkout failed", "error", 8000),
      },
    );
  };

  const handlePush = () => {
    if (!rootPath) return;
    gitPush.mutate(rootPath, {
      onSuccess: (r) => {
        toast(r.output || "Pushed", "success", 5000);
        refetchStatus();
      },
      onError: (err) => toast(err instanceof Error ? err.message : "Push failed", "error", 8000),
    });
  };

  const handleCommit = (andPush = false) => {
    if (!rootPath || !commitMsg.trim()) return;
    gitCommit.mutate(
      { rootPath, message: commitMsg.trim() },
      {
        onSuccess: (r) => {
          toast(`Committed ${r.hash}`, "success");
          setCommitMsg("");
          if (andPush) {
            gitPush.mutate(rootPath, {
              onSuccess: (pr) => {
                toast(pr.output || "Pushed", "success", 5000);
                refetchStatus();
              },
              onError: (err) =>
                toast(err instanceof Error ? err.message : "Push failed", "error", 8000),
            });
          }
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : "Commit failed", "error", 8000),
      },
    );
  };

  const totalChanges =
    (status?.staged.length ?? 0) + (status?.modified.length ?? 0) + (status?.untracked.length ?? 0);

  const tabs: { key: Tab; label: string }[] = [
    { key: "status", label: "Status" },
    { key: "log", label: "Log" },
    { key: "branches", label: "Branches" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg max-sm:mx-0 max-sm:w-full max-sm:max-w-full">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Git
            {status && (
              <span className="ml-1 font-mono text-xs text-muted-foreground">
                {status.branch}
                {status.ahead > 0 && <span className="text-green-500"> +{status.ahead}</span>}
                {status.behind > 0 && <span className="text-amber-500"> -{status.behind}</span>}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-px border border-border bg-card">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 px-3 py-1.5 text-xs font-mono transition-colors ${
                tab === t.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Status Tab */}
        {tab === "status" && (
          <div className="space-y-3">
            {statusLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}

            {status && !statusLoading && (
              <>
                {/* Changed files */}
                <div className="max-h-48 max-sm:max-h-60 overflow-y-auto border border-border">
                  {totalChanges === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      Working tree clean
                    </div>
                  )}
                  {status.staged.map((f) => (
                    <div
                      key={`s-${f}`}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                    >
                      <FileCheck className="h-3 w-3 text-green-500" />
                      <span className="truncate font-mono">{f}</span>
                      <span className="ml-auto text-2xs text-green-500">staged</span>
                    </div>
                  ))}
                  {status.modified.map((f) => (
                    <div
                      key={`m-${f}`}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                    >
                      <FileEdit className="h-3 w-3 text-amber-500" />
                      <span className="truncate font-mono">{f}</span>
                      <span className="ml-auto text-2xs text-amber-500">modified</span>
                    </div>
                  ))}
                  {status.untracked.map((f) => (
                    <div
                      key={`u-${f}`}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                    >
                      <FilePlus className="h-3 w-3 text-blue-500" />
                      <span className="truncate font-mono">{f}</span>
                      <span className="ml-auto text-2xs text-blue-500">untracked</span>
                    </div>
                  ))}
                </div>

                {/* Commit form */}
                {totalChanges > 0 && (
                  <div className="space-y-2">
                    {/* Task picker for commit message */}
                    {activeTasks.length > 0 && (
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setTaskPickerOpen(!taskPickerOpen)}
                          className="flex w-full items-center gap-1.5 border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
                        >
                          <ListTodo className="h-3 w-3" />
                          Use task title as commit message
                          <ChevronDown className="ml-auto h-3 w-3" />
                        </button>
                        {taskPickerOpen && (
                          <div className="absolute left-0 right-0 top-full z-10 mt-0.5 max-h-40 overflow-y-auto border border-border bg-popover">
                            {activeTasks.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => {
                                  setCommitMsg(t.title);
                                  setTaskPickerOpen(false);
                                }}
                                className="flex w-full items-center gap-2 border-b border-border px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-accent"
                              >
                                <span className="truncate">{t.title}</span>
                                <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                                  {t.status}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <Input
                      placeholder="Commit message..."
                      value={commitMsg}
                      onChange={(e) => setCommitMsg(e.target.value)}
                      className="text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && commitMsg.trim()) handleCommit(false);
                      }}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCommit(false)}
                        disabled={!commitMsg.trim() || gitCommit.isPending || gitPush.isPending}
                        className="gap-1"
                      >
                        {gitCommit.isPending && !gitPush.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <GitCommitHorizontal className="h-3 w-3" />
                        )}
                        Commit
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleCommit(true)}
                        disabled={!commitMsg.trim() || gitCommit.isPending || gitPush.isPending}
                        className="gap-1"
                      >
                        {gitCommit.isPending || gitPush.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Upload className="h-3 w-3" />
                        )}
                        Commit & Push
                      </Button>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePull}
                    disabled={gitPull.isPending}
                    className="gap-1 text-xs"
                  >
                    {gitPull.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Pull
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePush}
                    disabled={gitPush.isPending || (status?.ahead ?? 0) === 0}
                    className="gap-1 text-xs"
                  >
                    {gitPush.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Upload className="h-3 w-3" />
                    )}
                    Push
                    {(status?.ahead ?? 0) > 0 && (
                      <span className="text-2xs text-green-500">{status?.ahead}</span>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchStatus()}
                    className="gap-1 text-xs"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Refresh
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Log Tab */}
        {tab === "log" && (
          <div className="max-h-80 max-sm:max-h-[60vh] overflow-y-auto border border-border">
            {logLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {logEntries?.map((entry) => (
              <div key={entry.hash} className="border-b border-border px-3 py-2 last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-primary">{entry.shortHash}</span>
                  <span className="truncate text-sm">{entry.message}</span>
                </div>
                <div className="mt-0.5 text-2xs text-muted-foreground">
                  {entry.author} - {entry.relativeDate}
                </div>
              </div>
            ))}
            {!logLoading && logEntries?.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">No commits yet</div>
            )}
          </div>
        )}

        {/* Branches Tab */}
        {tab === "branches" && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetch}
                disabled={gitFetch.isPending}
                className="gap-1 text-xs"
              >
                {gitFetch.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                Fetch
              </Button>
            </div>
            <div className="max-h-72 max-sm:max-h-[55vh] overflow-y-auto border border-border">
              {branchesLoading && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {branchData?.branches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  disabled={branch === branchData.current || gitCheckout.isPending}
                  onClick={() => handleCheckout(branch)}
                  className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:opacity-70 ${
                    branch === branchData.current ? "bg-primary/10" : ""
                  }`}
                >
                  <GitBranch className="h-3 w-3" />
                  <span className="font-mono text-xs">{branch}</span>
                  {branch === branchData.current && (
                    <span className="ml-auto text-2xs text-primary">current</span>
                  )}
                </button>
              ))}
              {branchData?.remote && branchData.remote.length > 0 && (
                <>
                  <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wide">
                    Remote
                  </div>
                  {branchData.remote.map((branch) => (
                    <button
                      key={`remote-${branch}`}
                      type="button"
                      disabled={gitCheckout.isPending}
                      onClick={() => handleCheckout(branch)}
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:opacity-70"
                    >
                      <GitBranch className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono text-xs text-muted-foreground">{branch}</span>
                      <span className="ml-auto text-2xs text-muted-foreground">origin</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
