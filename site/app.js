(() => {
  const grid = document.querySelector("#service-grid");
  const count = document.querySelector("#service-count");
  const empty = document.querySelector("#empty-state");
  const year = document.querySelector("#footer-year");
  const title = document.querySelector("#portal-title");
  const subtitle = document.querySelector("#portal-subtitle");

  const icons = {
    storage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Z"/><path d="M8 7h8M8 11h8M8 15h.01"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/><path d="m10 8 5 4-5 4V8Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z"/><path d="M4 9h16"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>',
  };

  function isSafeHref(href) {
    try {
      const url = new URL(href, window.location.href);
      return url.protocol === "https:" && (url.hostname === "myfu.cn" || url.hostname.endsWith(".myfu.cn"));
    } catch {
      return false;
    }
  }

  function safeServices(items) {
    return Array.isArray(items)
      ? items.filter((item) => item && item.enabled !== false && isSafeHref(item.href) && typeof item.name === "string" && typeof item.description === "string")
      : [];
  }

  function render(nextConfig) {
    const links = safeServices(nextConfig.services);
    if (typeof nextConfig.title === "string") {
      title.textContent = nextConfig.title;
      const dot = document.createElement("span");
      dot.className = "hero-dot";
      dot.textContent = ".";
      title.append(dot);
      document.title = nextConfig.title;
    }
    if (typeof nextConfig.subtitle === "string") subtitle.textContent = nextConfig.subtitle;
    grid.replaceChildren();
    count.textContent = links.length ? `${links.length} 个服务` : "";
    empty.hidden = links.length > 0;

    links.forEach((service, index) => {
      const link = document.createElement("a");
      link.className = `service-card tone-${service.tone || "blue"}`;
      link.href = service.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.setProperty("--delay", `${Math.min(index, 6) * 70}ms`);

      const icon = document.createElement("span");
      icon.className = "service-icon";
      icon.innerHTML = icons[service.icon] || icons.storage;
      const content = document.createElement("span");
      content.className = "service-content";
      const serviceTitle = document.createElement("strong");
      serviceTitle.textContent = service.name;
      const description = document.createElement("span");
      description.className = "service-description";
      description.textContent = service.description;
      const arrow = document.createElement("span");
      arrow.className = "service-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      content.append(serviceTitle, description);
      link.append(icon, content, arrow);
      grid.append(link);
    });
  }

  async function loadConfig() {
    const fallback = {
      title: "我的服务中心",
      subtitle: "一个入口，访问你的 NAS 与自建服务。",
      services: Array.isArray(window.PORTAL_LINKS) ? window.PORTAL_LINKS : [],
    };
    try {
      const response = await fetch("/api/public/config", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("config_unavailable");
      render(await response.json());
    } catch {
      render(fallback);
    }
  }

  year.textContent = new Date().getFullYear();
  loadConfig();
})();
