(() => {
  const loginPanel = document.querySelector("#login-panel");
  const settingsPanel = document.querySelector("#settings-panel");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const logoutButton = document.querySelector("#logout-button");
  const titleInput = document.querySelector("#portal-title");
  const subtitleInput = document.querySelector("#portal-subtitle");
  const servicesList = document.querySelector("#services-list");
  const servicesError = document.querySelector("#services-error");
  const globalError = document.querySelector("#global-error");
  const saveState = document.querySelector("#save-state");
  const saveButton = document.querySelector("#save-button");
  const addButton = document.querySelector("#add-service-button");
  const passwordForm = document.querySelector("#password-form");
  const passwordState = document.querySelector("#password-state");
  const dialog = document.querySelector("#service-dialog");
  const serviceForm = document.querySelector("#service-form");
  const serviceDialogTitle = document.querySelector("#service-dialog-title");
  const serviceId = document.querySelector("#service-id");
  const serviceName = document.querySelector("#service-name");
  const serviceDescription = document.querySelector("#service-description");
  const serviceHref = document.querySelector("#service-href");
  const serviceIcon = document.querySelector("#service-icon");
  const serviceTone = document.querySelector("#service-tone");
  const serviceEnabled = document.querySelector("#service-enabled");
  const serviceFormError = document.querySelector("#service-form-error");
  const cancelServiceButton = document.querySelector("#cancel-service-button");

  let csrfToken = "";
  let config = null;
  let editingId = null;

  const labels = {
    storage: "存储",
    play: "播放",
    folder: "文件夹",
    screen: "屏幕",
    code: "代码",
  };

  function show(element, value = true) {
    element.hidden = !value;
  }

  function setError(element, message = "") {
    element.textContent = message;
    show(element, Boolean(message));
  }

  function setStatus(message, type = "") {
    saveState.textContent = message;
    saveState.className = `status-pill${type ? ` status-${type}` : ""}`;
  }

  async function request(url, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    if (!response.ok) {
      const error = new Error(payload?.error || `request_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function requireCsrf(options = {}) {
    return { ...options, headers: { ...(options.headers || {}), "X-CSRF-Token": csrfToken } };
  }

  function normalizeService(service) {
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      href: service.href,
      icon: service.icon,
      tone: service.tone,
      enabled: service.enabled !== false,
    };
  }

  function renderServices() {
    servicesList.replaceChildren();
    for (const [index, service] of config.services.entries()) {
      const item = document.createElement("article");
      item.className = `admin-service-row${service.enabled ? "" : " is-disabled"}`;

      const marker = document.createElement("span");
      marker.className = `service-icon tone-${service.tone}`;
      marker.textContent = labels[service.icon] || "服务";
      marker.setAttribute("aria-hidden", "true");

      const content = document.createElement("div");
      content.className = "admin-service-content";
      const name = document.createElement("strong");
      name.textContent = service.name;
      const description = document.createElement("span");
      description.textContent = `${service.description} · ${service.enabled ? "已启用" : "已停用"}`;
      const href = document.createElement("code");
      href.textContent = service.href;
      content.append(name, description, href);

      const controls = document.createElement("div");
      controls.className = "admin-service-controls";
      const up = actionButton("上移", "↑", () => moveService(index, -1), index === 0);
      const down = actionButton("下移", "↓", () => moveService(index, 1), index === config.services.length - 1);
      const edit = actionButton("编辑", "编辑", () => openServiceDialog(service));
      const remove = actionButton("删除", "删除", () => removeService(service.id), false, "danger");
      controls.append(up, down, edit, remove);
      item.append(marker, content, controls);
      servicesList.append(item);
    }
  }

  function actionButton(label, text, handler, disabled = false, variant = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mini-button${variant ? ` mini-${variant}` : ""}`;
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.disabled = disabled;
    button.addEventListener("click", handler);
    return button;
  }

  function moveService(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= config.services.length) return;
    const [service] = config.services.splice(index, 1);
    config.services.splice(target, 0, service);
    renderServices();
    setStatus("有未保存修改", "pending");
  }

  function removeService(id) {
    const service = config.services.find((item) => item.id === id);
    if (!service || !window.confirm(`确定删除“${service.name}”吗？此操作需要保存后才会生效。`)) return;
    config.services = config.services.filter((item) => item.id !== id);
    renderServices();
    setStatus("有未保存修改", "pending");
  }

  function openServiceDialog(service = null) {
    editingId = service?.id || null;
    serviceDialogTitle.textContent = service ? "编辑服务" : "添加服务";
    serviceId.value = service?.id || `service-${Date.now().toString(36)}`;
    serviceName.value = service?.name || "";
    serviceDescription.value = service?.description || "";
    serviceHref.value = service?.href || "https://";
    serviceIcon.value = service?.icon || "storage";
    serviceTone.value = service?.tone || "blue";
    serviceEnabled.checked = service?.enabled !== false;
    setError(serviceFormError);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    serviceName.focus();
  }

  function closeServiceDialog() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function saveDialogService(event) {
    event.preventDefault();
    const id = serviceId.value.trim();
    const service = normalizeService({ id, name: serviceName.value.trim(), description: serviceDescription.value.trim(), href: serviceHref.value.trim(), icon: serviceIcon.value, tone: serviceTone.value, enabled: serviceEnabled.checked });
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(service.id) || service.id.length > 40) return setError(serviceFormError, "ID 只能包含小写字母、数字、短横线和下划线。");
    if (!service.name || !service.description || !service.href) return setError(serviceFormError, "请完整填写名称、描述和 HTTPS 链接。");
    try {
      const url = new URL(service.href);
      if (url.protocol !== "https:" || (url.hostname !== "myfu.cn" && !url.hostname.endsWith(".myfu.cn"))) throw new Error();
    } catch {
      return setError(serviceFormError, "链接必须是 myfu.cn 及其子域名下的 HTTPS 地址。");
    }
    const duplicate = config.services.some((item) => item.id === service.id && item.id !== editingId);
    if (duplicate) return setError(serviceFormError, "服务 ID 已存在，请换一个。");
    if (editingId) {
      const index = config.services.findIndex((item) => item.id === editingId);
      if (index >= 0) config.services[index] = service;
    } else {
      config.services.push(service);
    }
    renderServices();
    setStatus("有未保存修改", "pending");
    closeServiceDialog();
  }

  function populate(nextConfig) {
    config = { title: nextConfig.title, subtitle: nextConfig.subtitle, services: nextConfig.services.map(normalizeService) };
    titleInput.value = config.title;
    subtitleInput.value = config.subtitle;
    renderServices();
    setStatus("已加载", "success");
  }

  async function enterSettings(payload) {
    csrfToken = payload.csrfToken;
    populate(payload.config);
    show(loginPanel, false);
    show(settingsPanel, true);
    show(logoutButton, true);
  }

  async function checkSession() {
    try {
      await enterSettings(await request("/api/admin/session"));
    } catch (error) {
      if (error.status !== 401) setError(loginError, "暂时无法连接设置服务，请稍后重试。");
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(loginError);
    const password = new FormData(loginForm).get("password");
    try {
      await enterSettings(await request("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }));
      loginForm.reset();
    } catch (error) {
      setError(loginError, error.status === 429 ? "尝试次数过多，请稍后再试。" : "密码不正确，或登录服务暂时不可用。");
    }
  });

  logoutButton.addEventListener("click", async () => {
    try { await request("/api/admin/logout", requireCsrf({ method: "POST" })); } catch { /* clear local state even if network is unavailable */ }
    csrfToken = "";
    config = null;
    show(settingsPanel, false);
    show(logoutButton, false);
    show(loginPanel, true);
  });

  saveButton.addEventListener("click", async () => {
    setError(globalError);
    config.title = titleInput.value.trim();
    config.subtitle = subtitleInput.value.trim();
    saveButton.disabled = true;
    setStatus("保存中…", "pending");
    try {
      const saved = await request("/api/admin/config", requireCsrf({ method: "PUT", body: JSON.stringify(config) }));
      populate(saved);
      setStatus("已保存", "success");
    } catch (error) {
      setStatus("保存失败", "error");
      setError(globalError, error.status === 403 ? "会话已失效，请重新登录。" : "配置未保存，请检查字段后重试。");
      if (error.status === 401 || error.status === 403) {
        show(settingsPanel, false); show(logoutButton, false); show(loginPanel, true);
      }
    } finally {
      saveButton.disabled = false;
    }
  });

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(passwordState);
    const currentPassword = document.querySelector("#current-password").value;
    const newPassword = document.querySelector("#new-password").value;
    const confirmPassword = document.querySelector("#confirm-password").value;
    if (newPassword !== confirmPassword) return setError(passwordState, "两次输入的新密码不一致。");
    if (newPassword.length < 8) return setError(passwordState, "新密码至少需要 8 个字符。");
    if (!window.confirm("修改密码后当前会话会立即退出，确定继续吗？")) return;
    try {
      await request("/api/admin/password", requireCsrf({ method: "POST", body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) }));
      passwordForm.reset();
      csrfToken = "";
      show(settingsPanel, false); show(logoutButton, false); show(loginPanel, true);
      setError(loginError, "密码已更新，请使用新密码登录。");
    } catch {
      setError(passwordState, "密码更新失败，请确认当前密码和新密码要求。");
    }
  });

  addButton.addEventListener("click", () => openServiceDialog());
  serviceForm.addEventListener("submit", saveDialogService);
  cancelServiceButton.addEventListener("click", closeServiceDialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeServiceDialog(); });
  checkSession();
})();
