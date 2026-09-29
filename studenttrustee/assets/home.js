/* Freshness line. The verified date is stamped into the page by the build
   (data/site.json -> data-verified); this only adds the "check before you rely
   on it" warning once the roster is more than 60 days old. */
(function () {
  var el = document.getElementById("freshness");
  if (!el || !el.dataset.verified) return;
  var d = new Date(el.dataset.verified + "T00:00:00");
  if (isNaN(d)) return;
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var days = Math.round((today - d) / 86400000);
  if (days >= 60 && el.textContent.indexOf("check with the district") === -1) {
    el.textContent += " Some entries may have changed since, so check with the district before you rely on one.";
  }
})();
