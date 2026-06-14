import { useState } from "react";
import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useTasksImportStatus, useImportTasks } from "@/hooks/useImportTasks";

interface Props {
  projectId: string | null;
}

function disabledReason(args: {
  projectId: string | null;
  available: boolean | undefined;
  statusLoaded: boolean;
}): string | null {
  if (!args.projectId) return "Select a project";
  if (!args.statusLoaded) return null;
  if (args.available === false) return "No importable .md files under tasks/";
  return null;
}

export function ImportTasksButton({ projectId }: Props) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);

  const status = useTasksImportStatus(projectId);
  const mutation = useImportTasks();

  const statusLoaded = !status.isLoading && status.data !== undefined;
  const available = status.data?.available;
  const candidateCount = status.data?.candidateCount ?? 0;
  const subfolders = status.data?.subfolders ?? [];

  const tooltipText = disabledReason({ projectId, available, statusLoaded });
  const isDisabled = !projectId || status.isLoading || available === false || mutation.isPending;

  // Hide the button entirely when there is nothing to import (no project, or no
  // importable .md files under tasks/). It reappears automatically once the
  // import status reports available files — e.g. after a git pull invalidates it.
  if (!projectId || available !== true) return null;

  const handleConfirm = () => {
    if (!projectId) return;
    mutation.mutate(projectId, {
      onSuccess: (data) => {
        setDialogOpen(false);
        toast(`Imported ${data.created}/${candidateCount} tasks`, "success");
        if (data.errors.length > 0) {
          const head = data.errors
            .slice(0, 3)
            .map((e) => `${e.file} (${e.reason})`)
            .join(", ");
          const tail = data.errors.length > 3 ? ` ... and ${data.errors.length - 3} more` : "";
          toast(`Skipped: ${head}${tail}`, "warning", 8000);
        }
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Import failed";
        toast(message, "error", 8000);
      },
    });
  };

  const button = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setDialogOpen(true)}
      disabled={isDisabled}
      className="gap-1 font-mono text-3xs"
      aria-label="Import tasks from tasks/ folder"
    >
      <FolderInput className="h-3.5 w-3.5" />
      <span className="hidden md:inline">
        IMPORT TASKS
        {!isDisabled && candidateCount > 0 ? ` (${candidateCount})` : ""}
      </span>
    </Button>
  );

  return (
    <>
      {tooltipText ? (
        <Tooltip content={tooltipText}>
          <span>{button}</span>
        </Tooltip>
      ) : (
        button
      )}
      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Import tasks from tasks/ folder"
        description={
          subfolders.length > 0
            ? `Import ${candidateCount} task(s) from ${subfolders.join(", ")}. Files will be moved to .imported/ after creation.`
            : `Import ${candidateCount} task(s). Files will be moved to .imported/ after creation.`
        }
        confirmLabel="Import"
        cancelLabel="Cancel"
        disabled={mutation.isPending}
        onConfirm={handleConfirm}
      />
    </>
  );
}
