/* Marks past calendar events and computes the "Next up" box. */
(function(){
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var today = new Date(); today.setHours(0,0,0,0);
  var evs = [].slice.call(document.querySelectorAll(".ev"));
  var next = null;
  evs.forEach(function(el){
    var p = el.dataset.date.split("-");
    var d = new Date(+p[0], +p[1]-1, +p[2]);
    el.querySelector(".when .d").textContent = MON[d.getMonth()] + " " + d.getDate();
    if (d < today) el.classList.add("past");
    else if (!next) { next = {el: el, date: d}; el.classList.add("is-next"); }
  });
  if (next){
    var days = Math.round((next.date - today) / 86400000);
    document.getElementById("next-name").textContent =
      next.el.querySelector(".what h3").textContent;
    document.getElementById("next-when").textContent =
      days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days";
    document.getElementById("next").hidden = false;
  }
})();
