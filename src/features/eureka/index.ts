import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { cancelRefresh, EUREKA_WINDOW, watchEnvironments } from "./store";

export function activate(): () => void {
  const disposers = [
    watchEnvironments(),
    registerToolWindow({
      id: EUREKA_WINDOW,
      title: "Eureka",
      icon: "toolwindow-eureka",
      anchor: "right",
      order: 19,
      component: lazyComponent(() => import("./EurekaView").then((m) => m.EurekaView)),
    }),
    registerActions([
      {
        id: "eureka.show",
        title: "Eureka",
        description: "Manage Eureka service instances across environments",
        category: "Tools",
        icon: "toolwindow-eureka",
        keywords: ["eureka", "registry", "environment", "service", "注册中心", "环境"],
        when: "projectOpen",
        run: () => toolWindowService().show(EUREKA_WINDOW, true),
      },
    ]),
    cancelRefresh,
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
