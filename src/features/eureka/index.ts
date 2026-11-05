import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { registerServiceView, showServiceView } from "@/workbench/contributions";
import { cancelRefresh, EUREKA_VIEW, watchEnvironments } from "./store";

export function activate(): () => void {
  const disposers = [
    watchEnvironments(),
    registerServiceView({
      id: EUREKA_VIEW,
      title: "Eureka",
      icon: "toolwindow-services",
      order: 30,
      component: lazyComponent(() => import("./EurekaView").then((m) => m.EurekaView)),
    }),
    registerActions([
      {
        id: "eureka.show",
        title: "Eureka",
        description: "Manage Eureka service instances across environments",
        category: "Tools",
        icon: "toolwindow-services",
        keywords: ["eureka", "registry", "environment", "service", "注册中心", "环境"],
        when: "projectOpen",
        run: () => showServiceView(EUREKA_VIEW, true),
      },
    ]),
    cancelRefresh,
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
