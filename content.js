console.log("GitHub extension loaded");

const btn = document.createElement("button");
btn.innerText = "Test Button";
btn.style.position = "fixed";
btn.style.top = "20px";
btn.style.right = "20px";
btn.style.zIndex = "9999";

btn.onclick = () => {
  alert("It works!");
};

document.body.appendChild(btn);
