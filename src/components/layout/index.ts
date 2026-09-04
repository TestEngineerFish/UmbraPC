// 页面骨架（批次 012）：一个页头 + 五个内容模板 + 三态。页面只填内容槽。
// 唯一取值来源：《PC 页面骨架.dc.html》/ tokens.pageHeader + tokens.pageTemplate。
export { PageHeader, HeaderSearch, headerIconBtn, type PageHeaderProps, type HeaderButton } from "./PageHeader";
export { PageShell, usePageSettings, type PageSettings } from "./PageShell";
export { ListDetail, DetailPlaceholder, SectionHeader, StatBar, DetailHead, detailIconBtn, ListRow, CardList, ListCard, MultiSelectBar } from "./ListDetail";
export { ListModal, Group, GroupRow, RowExpand, useFlashId } from "./ListModal";
export { SettingsPage, SettingsSection, type SubNavGroup, type SubNavItem } from "./SettingsPage";
export { Dashboard, CardGrid, DashCard, StatusCard, FooterTotal } from "./Dashboard";
export { Skeleton, PageError, PageBanner, SyncSpinner, Workbench } from "./states";
