import { useState, useMemo } from "react";
import { GitBranch, Lock, Globe, Search, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useGitHubRepos, useCloneRepo } from "@/hooks/useGitHub";
import { useCreateProject } from "@/hooks/useProjects";
import type { Project } from "@aif/shared/browser";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectCreated: (project: Project) => void;
}

export function GitHubImportDialog({ open, onOpenChange, onProjectCreated }: Props) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: repos, isLoading, error } = useGitHubRepos(open);
  const cloneRepo = useCloneRepo();
  const createProject = useCreateProject();
  const [cloningRepo, setCloningRepo] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!repos) return [];
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.nameWithOwner.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [repos, search]);

  const handleImport = (repoFullName: string) => {
    setCloningRepo(repoFullName);
    const repoName = repoFullName.split("/").pop() ?? repoFullName;

    cloneRepo.mutate(
      { repoFullName },
      {
        onSuccess: (result) => {
          if (result.alreadyExists) {
            toast(`"${repoName}" already cloned, creating project...`, "info");
          }

          createProject.mutate(
            { name: repoName, rootPath: result.path },
            {
              onSuccess: (project) => {
                toast(`Project "${repoName}" created`, "success");
                onProjectCreated(project);
                onOpenChange(false);
                setCloningRepo(null);
                setSearch("");
              },
              onError: (err) => {
                toast(
                  err instanceof Error ? err.message : "Failed to create project",
                  "error",
                  8000,
                );
                setCloningRepo(null);
              },
            },
          );
        },
        onError: (err) => {
          toast(err instanceof Error ? err.message : "Clone failed", "error", 8000);
          setCloningRepo(null);
        },
      },
    );
  };

  const isPending = cloneRepo.isPending || createProject.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Import from GitHub
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-80 overflow-y-auto border border-border">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repositories...
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load repos"}
            </div>
          )}

          {!isLoading && !error && filtered.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {search ? "No matching repositories" : "No repositories found"}
            </div>
          )}

          {filtered.map((repo) => (
            <button
              key={repo.nameWithOwner}
              type="button"
              disabled={isPending}
              onClick={() => handleImport(repo.nameWithOwner)}
              className="flex w-full items-start gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent disabled:opacity-50"
            >
              <div className="mt-0.5">
                {repo.isPrivate ? (
                  <Lock className="h-3.5 w-3.5 text-amber-500" />
                ) : (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{repo.nameWithOwner}</span>
                  {cloningRepo === repo.nameWithOwner && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                </div>
                {repo.description && (
                  <div className="truncate text-xs text-muted-foreground">{repo.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
