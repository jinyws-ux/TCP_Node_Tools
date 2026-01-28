(function () {
  const phrases = [
    "❤IPS-L PPE❤",
    "❤IPS-L OSM❤",
    "❤IPS-C ICE❤",
    "❤IPS-C HVB❤",
    "❤GEN6 IPS-C❤",
    "❤IPS-T❤",
    "❤IPS-I❤",
    "❤IPS-Q❤",
    "❤BVIS❤",
    "❤APDM❤",
    "❤CASCADE❤",
    "❤IQP❤",
    "❤KSI❤",
    "❤PPZ❤",
    "❤PROFEP❤",
    "❤PLANTCON❤",
    "❤SERAFINA❤",
  ];

  let phraseIndex = 0;

  function randomColor() {
    const r = Math.floor(Math.random() * 255);
    const g = Math.floor(Math.random() * 255);
    const b = Math.floor(Math.random() * 255);
    return `rgb(${r},${g},${b})`;
  }

  function onClick(event) {
    const heart = document.createElement("b");
    heart.textContent = phrases[phraseIndex];
    phraseIndex = (phraseIndex + 1) % phrases.length;

    heart.style.position = "fixed";
    heart.style.left = "-100%";
    heart.style.userSelect = "none";
    heart.style.pointerEvents = "none";
    heart.style.cursor = "default";
    heart.style.zIndex = "999999";
    document.body.appendChild(heart);

    const fontSize = 16;
    let x = (event.clientX || 0) - fontSize / 2;
    let y = (event.clientY || 0) - fontSize;
    const color = randomColor();
    let opacity = 1;
    let scale = 1.2;

    const timer = window.setInterval(() => {
      if (opacity <= 0) {
        try {
          heart.remove();
        } catch (_) {
          if (heart.parentNode) heart.parentNode.removeChild(heart);
        }
        window.clearInterval(timer);
        return;
      }

      heart.style.fontSize = `${fontSize}px`;
      heart.style.color = color;
      heart.style.left = `${x}px`;
      heart.style.top = `${y}px`;
      heart.style.opacity = String(opacity);
      heart.style.transform = `scale(${scale})`;

      y -= 1;
      opacity -= 0.016;
      scale += 0.002;
    }, 15);
  }

  if (window.__LOGTOOL_CLICK_EFFECT_INSTALLED__) return;
  window.__LOGTOOL_CLICK_EFFECT_INSTALLED__ = true;
  window.addEventListener("click", onClick);
})();
