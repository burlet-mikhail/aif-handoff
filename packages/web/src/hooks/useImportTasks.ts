import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useTasksImportStatus(projectId: string | null) {
  return useQuery({
    queryKey: ["tasks-import-status", projectId],
    queryFn: () => api.getTasksImportStatus(projectId!),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

export function useImportTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.importTasks(projectId),
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-import-status", projectId] });
    },
  });
}
