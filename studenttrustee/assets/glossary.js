/* Glossary filter. The box stays hidden without JavaScript, so the full list always reads on its own.
   Typing hides terms that do not contain the text (in the term or its definition), hides sections left
   empty, and announces the count through a status line. */
(function () {
  "use strict";
  var box = document.querySelector(".gl-find");
  var input = document.getElementById("gl-q");
  var count = document.getElementById("gl-count");
  if (!box || !input || !count) return;
  var terms = Array.prototype.slice.call(document.querySelectorAll(".gl-term"));
  var sections = Array.prototype.slice.call(document.querySelectorAll(".gl-section"));
  var text = terms.map(function (t) { return t.textContent.toLowerCase().replace(/\s+/g, " "); });
  box.hidden = false;
  var timer = null;
  function apply() {
    var q = input.value.trim().toLowerCase().replace(/\s+/g, " ");
    var shown = 0;
    terms.forEach(function (t, i) {
      var hit = !q || text[i].indexOf(q) !== -1;
      t.hidden = !hit;
      if (hit) shown++;
    });
    sections.forEach(function (s) {
      var any = s.querySelector(".gl-term:not([hidden])");
      var none = s.querySelector(".gl-none");
      if (none) none.hidden = !!any || !q;
    });
    count.textContent = q ? (shown === 1 ? "1 term matches." : shown + " terms match.") : "";
  }
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(apply, 250);
  });
})();
