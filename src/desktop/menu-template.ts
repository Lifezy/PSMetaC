export interface ApplicationMenuActions {
  navigate: (view: string) => void;
  hide: () => void;
  quit: () => void;
  toggleQueue: () => void;
  showAbout: () => void;
}

export function createChineseApplicationMenuTemplate(
  queue: {
    paused?: boolean;
    criticalReason?: string | null;
    available: boolean;
  },
  actions: ApplicationMenuActions,
): Array<Record<string, unknown>> {
  return [
    {
      label: "文件",
      submenu: [
        {
          label: "处理文件",
          accelerator: "Ctrl+N",
          click: () => actions.navigate("new-task"),
        },
        {
          label: "设置",
          accelerator: "Ctrl+,",
          click: () => actions.navigate("settings"),
        },
        { type: "separator" },
        { label: "隐藏窗口（继续后台运行）", click: actions.hide },
        {
          label: "退出",
          accelerator: "Alt+F4",
          click: actions.quit,
        },
      ],
    },
    {
      label: "任务",
      submenu: [
        {
          label: "查看任务记录",
          click: () => actions.navigate("jobs"),
        },
        {
          label: queue.paused ? "继续处理任务" : "暂停处理新任务",
          enabled: queue.available && !queue.criticalReason,
          click: actions.toggleQueue,
        },
        {
          label: "检查运行环境",
          click: () => actions.navigate("diagnostics"),
        },
      ],
    },
    {
      label: "查看",
      submenu: [
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { label: "恢复默认缩放", role: "resetZoom" },
        { type: "separator" },
        { label: "全屏", role: "togglefullscreen" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "认识与使用 PSMetaC",
          accelerator: "F1",
          click: () => actions.navigate("help"),
        },
        { label: "关于", click: actions.showAbout },
      ],
    },
  ];
}
