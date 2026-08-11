import { breadcrumbGroup, sideNavigation } from "./components.js";
import { readPinnedServices } from "./pinned-services.js";

export function createShell(serviceMeta, { sidebar, serviceHeader, navigationButton }) {
  let homeServices = Object.values(serviceMeta).flatMap(service => {
    if (service.key === "home") return [];
    const firstLink = service.links?.find(link => !link[2]);
    if (!firstLink) return [];
    return [{ key: service.key, name: service.key === "systems-manager" ? "Parameter Store" : service.name, cls: service.cls, icon: service.icon, href: firstLink[1] }];
  });

  function pinnedHomeServices() {
    const pinned = readPinnedServices();
    return homeServices.filter(service => pinned.has(service.key));
  }

  function renderSidebar(service) {
    const metadata = serviceMeta[service];
    sidebar.innerHTML = sideNavigation(metadata, location.hash, pinnedHomeServices());
  }

  function closeNavigation(restoreFocus = false) {
    sidebar.classList.remove("open");
    navigationButton?.setAttribute("aria-expanded", "false");
    navigationButton?.setAttribute("aria-label", "Open navigation");
    if (restoreFocus && navigationButton instanceof HTMLElement && navigationButton.isConnected) navigationButton.focus();
  }

  function setChrome(service, crumbs = []) {
    renderSidebar(service);
    serviceHeader.innerHTML = breadcrumbGroup(service, crumbs, location.hash);
    closeNavigation();
  }

  function setHomeServices(services) {
    homeServices = [...services];
    if (location.hash.replace(/\/+$/, "") === "#/home") renderSidebar("home");
  }

  return { setChrome, setHomeServices, closeNavigation };
}
