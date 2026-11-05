/** Visual API debugging, sharing the HTTP engine and Spring endpoint providers. */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import { lazyComponent } from "@/ui";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { API_CLIENT_WINDOW, newRequest, openProject } from "./store";

export function activate(): () => void {
  const synchronizeProject = () => {
    const root = useProject.getState().project?.root ?? null;
    openProject(root, projectLocation(root));
  };
  synchronizeProject();
  const disposers = [
    useProject.subscribe((state, previous) => {
      if (state.project?.root !== previous.project?.root) synchronizeProject();
    }),
    useRemote.subscribe((state, previous) => {
      if (state.session !== previous.session) synchronizeProject();
    }),
    registerToolWindow({
      id: API_CLIENT_WINDOW,
      title: "API Client",
      icon: "toolwindow-api",
      anchor: "right",
      order: 18,
      component: lazyComponent(() => import("./ApiClientView").then((module) => module.ApiClientView)),
    }),
    registerActions([
      {
        id: "apiClient.show",
        title: "API Client",
        description: "Browse and test project APIs across environments",
        category: "Tools",
        icon: "toolwindow-api",
        when: "projectOpen",
        keywords: ["HTTP", "REST", "Spring", "API", "接口调试", "请求"],
        run: () => toolWindowService().show(API_CLIENT_WINDOW, true),
      },
      {
        id: "apiClient.newRequest",
        title: "New API request",
        category: "Tools",
        icon: "plus",
        when: "projectOpen",
        run: () => {
          newRequest();
          toolWindowService().show(API_CLIENT_WINDOW, true);
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
