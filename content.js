console.log("GitHub Enhancer Loaded");

// Find repo title
const repoName = document.querySelector("strong a");

if (repoName) {
  const btn = document.createElement("button");
  btn.innerText = "📋 Copy Repo";
  btn.className = "gh-copy-btn";

  btn.onclick = () => {
    navigator.clipboard.writeText(repoName.innerText);
    btn.innerText = "✅ Copied!";
    setTimeout(() => (btn.innerText = "📋 Copy Repo"), 1500);
  };

  repoName.parentElement.appendChild(btn);
}
