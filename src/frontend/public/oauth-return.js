const result = document.currentScript?.dataset.result;
const allowed = ["connected", "warning", "cancelled", "failed"];
window.location.replace(`/?oauth=${allowed.includes(result) ? result : "failed"}`);
