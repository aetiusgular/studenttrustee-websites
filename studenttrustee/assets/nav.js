/* Site nav menus (Get Started, District map). Each menu is a disclosure: the button beside the
   link opens a list of links. The list is position:fixed and placed under its button, so a toolbar
   that scrolls sideways (the map page on a phone) never clips it. One menu is open at a time;
   Escape closes it and returns focus to the button, and so does clicking or tabbing away. */
(function () {
  "use strict";
  var open = null;
  function place(btn, menu) {
    var r = btn.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var w = menu.offsetWidth;
    var item = btn.parentElement;
    var left = item.classList.contains("right") ? r.right - w : item.getBoundingClientRect().left;
    menu.style.top = Math.round(r.bottom + 4) + "px";
    menu.style.left = Math.round(Math.max(8, Math.min(left, vw - w - 8))) + "px";
  }
  function close(refocus) {
    if (!open) return;
    var o = open;
    open = null;
    o.btn.setAttribute("aria-expanded", "false");
    o.menu.hidden = true;
    if (refocus) o.btn.focus();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav-toggle"), function (btn) {
    var menu = document.getElementById(btn.getAttribute("aria-controls"));
    if (!menu) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open && open.btn === btn) { close(false); return; }
      close(false);
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      place(btn, menu);
      open = { btn: btn, menu: menu };
    });
    btn.parentElement.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open && open.btn === btn) { e.preventDefault(); close(true); }
    });
    btn.parentElement.addEventListener("focusout", function (e) {
      if (open && open.btn === btn && !btn.parentElement.contains(e.relatedTarget)) close(false);
    });
  });
  document.addEventListener("click", function (e) {
    if (open && !open.menu.contains(e.target)) close(false);
  });
  window.addEventListener("resize", function () { close(false); });
  window.addEventListener("scroll", function () { if (open) place(open.btn, open.menu); }, { passive: true });
})();
