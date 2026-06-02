/* Shared lightbox — click any ranking or admin photo to view it full-size.
 *
 * Self-contained and dependency-free. Included by index.html, live.html, and
 * admin.html. Uses event delegation, so it works on photos rendered at any time
 * (results grids, the live leaderboard, the admin roster, etc.). A clicked
 * thumbnail is shown at its true aspect ratio (no square crop) in an overlay.
 */
(function () {
  let overlay = null, imgEl = null, capEl = null;

  function build() {
    overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.hidden = true;
    overlay.innerHTML =
      '<button class="lightbox-close" type="button" aria-label="Close">✕</button>' +
      '<figure class="lightbox-figure">' +
      '<img class="lightbox-img" alt="" />' +
      '<figcaption class="lightbox-cap"></figcaption>' +
      '</figure>';
    imgEl = overlay.querySelector(".lightbox-img");
    capEl = overlay.querySelector(".lightbox-cap");
    document.body.appendChild(overlay);
    // Click anywhere except the image itself closes the lightbox.
    overlay.addEventListener("click", function (e) {
      if (e.target !== imgEl) close();
    });
  }

  function open(src, alt) {
    if (!overlay) build();
    imgEl.src = src;
    imgEl.alt = alt || "";
    capEl.textContent = alt || "";
    overlay.hidden = false;
    document.body.classList.add("lightbox-open");
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    imgEl.removeAttribute("src");
    document.body.classList.remove("lightbox-open");
  }

  // Open on any photo inside a ranking card or an admin card.
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    const img = e.target.closest(".rank-item img, .admin-card img");
    if (!img || !img.getAttribute("src")) return;
    e.preventDefault();
    open(img.currentSrc || img.src, img.alt);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
})();
