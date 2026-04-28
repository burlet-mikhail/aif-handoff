import { useState } from "react";
import type { TaskCommentAttachment } from "@aif/shared/browser";
import { ToggleButton } from "@/components/ui/toggle-button";
import { FileInput } from "@/components/ui/file-input";
import { DropZone } from "@/components/ui/drop-zone";
import { FileListItem } from "@/components/ui/file-list-item";
import { summarizeAttachments } from "@/lib/attachmentTransfer";
import { MAX_TASK_ATTACHMENTS, TASK_ATTACHMENT_WARN_AT } from "./useTaskDetailActions";

interface TaskAttachmentsProps {
  taskId: string;
  attachments: TaskCommentAttachment[];
  onFilesSelected: (files: File[]) => void;
  onRemove: (index: number) => void;
}

export function TaskAttachments({
  taskId,
  attachments,
  onFilesSelected,
  onRemove,
}: TaskAttachmentsProps) {
  const [expanded, setExpanded] = useState(false);
  const total = summarizeAttachments(attachments);
  const showWarning = attachments.length >= TASK_ATTACHMENT_WARN_AT;
  const atCap = attachments.length >= MAX_TASK_ATTACHMENTS;

  return (
    <div className="space-y-3">
      <ToggleButton expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? "Hide attachments" : `Show attachments (${attachments.length})`}
      </ToggleButton>

      {expanded && (
        <>
          <DropZone onFiles={(files) => onFilesSelected(files)} />
          <FileInput
            multiple
            label="Attach files"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                onFilesSelected(Array.from(files));
              }
              e.currentTarget.value = "";
            }}
          />
          {attachments.length > 0 && <p className="text-2xs text-muted-foreground">{total}</p>}
          {showWarning && !atCap && (
            <p className="text-2xs text-amber-600 dark:text-amber-400">
              Large batch ({attachments.length} files). Cap is {MAX_TASK_ATTACHMENTS}; agent prompts
              may grow accordingly.
            </p>
          )}
          {atCap && (
            <p className="text-2xs text-amber-600 dark:text-amber-400">
              Attachment cap reached ({MAX_TASK_ATTACHMENTS}). New files will be ignored.
            </p>
          )}
          {attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No files attached to this task.</p>
          ) : (
            <ul className="space-y-1">
              {attachments.map((file, index) => (
                <FileListItem
                  key={`${file.name}-${index}`}
                  name={file.name}
                  mimeType={file.mimeType}
                  size={file.size}
                  downloadUrl={
                    file.path
                      ? `/tasks/${taskId}/attachments/${encodeURIComponent(file.name)}`
                      : undefined
                  }
                  metadataOnly={file.content == null && !file.path}
                  onRemove={() => onRemove(index)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
