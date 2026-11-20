/* "Puff" - the sticky's own mascot. Drawn as inline SVG so CSS can animate every part. */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const r1 = (v) => Math.round(v * 10) / 10;

  // A closed path of small outward bumps around an ellipse: the fluffy outline.
  function fluff(cx, cy, rx, ry, bumps, k, rot) {
    const pts = [];
    for (let i = 0; i < bumps; i++) {
      const a = (rot || 0) + (i / bumps) * TAU;
      pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    for (let i = 0; i < bumps; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % bumps];
      const rad = Math.hypot(q[0] - p[0], q[1] - p[1]) * (k || 0.6);
      d += `A${r1(rad)} ${r1(rad)} 0 0 1 ${r1(q[0])} ${r1(q[1])}`;
    }
    return d + 'Z';
  }

  function star(cx, cy, s) {
    return `M${cx} ${cy - s}Q${cx} ${cy} ${cx + s} ${cy}Q${cx} ${cy} ${cx} ${cy + s}Q${cx} ${cy} ${cx - s} ${cy}Q${cx} ${cy} ${cx} ${cy - s}Z`;
  }

  const FUR = { light: '#FFF7E8', mid: '#F8E4C4', shade: '#E9CDA2', deep: '#D7B27E' };
  const INK = '#2A2230';
  const CHEEK = '#FF9AA2';
  const MOUTH = '#8A3F4A';

  const DEFS = `
<radialGradient id="puff-fur" cx="36%" cy="26%" r="85%">
  <stop offset="0" stop-color="${FUR.light}"/><stop offset="0.62" stop-color="${FUR.mid}"/><stop offset="1" stop-color="${FUR.shade}"/>
</radialGradient>
<radialGradient id="puff-face" cx="50%" cy="32%" r="78%">
  <stop offset="0" stop-color="#FFEFE3"/><stop offset="1" stop-color="#FFDCC8"/>
</radialGradient>
<linearGradient id="puff-lid" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#F6F8FC"/><stop offset="1" stop-color="#CBD3E1"/>
</linearGradient>
<linearGradient id="puff-icon-bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#5B9BFF"/><stop offset="1" stop-color="#8A6BFF"/>
</linearGradient>`;

  /* ---------- full-body hero (200 x 200) ---------- */
  function heroInner() {
    return `
<ellipse class="m-shadow" cx="100" cy="188" rx="54" ry="6.5" fill="rgba(20,24,50,.16)"/>
<g class="m-all">
  <g class="m-zzz" font-family="Segoe UI, system-ui, sans-serif" font-weight="800">
    <text class="m-z m-z1" x="150" y="58" font-size="15">z</text>
    <text class="m-z m-z2" x="161" y="42" font-size="19">z</text>
    <text class="m-z m-z3" x="174" y="24" font-size="24">Z</text>
  </g>
  <g class="m-sparks" fill="#FFC94D">
    <path class="m-spark m-s1" d="${star(26, 52, 9)}"/>
    <path class="m-spark m-s2" d="${star(176, 70, 7)}"/>
    <path class="m-spark m-s3" d="${star(160, 22, 11)}"/>
    <path class="m-spark m-s4" d="${star(38, 16, 6)}"/>
  </g>
  <g class="m-feet" fill="${FUR.shade}">
    <ellipse cx="77" cy="181" rx="17" ry="8.5"/><ellipse cx="123" cy="181" rx="17" ry="8.5"/>
  </g>
  <g class="m-body">
    <path d="${fluff(100, 131, 61, 51, 19, 0.6, 0.12)}" fill="${FUR.shade}"/>
    <path d="${fluff(100, 128, 57, 48, 21, 0.6, 0.35)}" fill="url(#puff-fur)"/>
  </g>
  <g class="m-arm m-arm-l"><path d="${fluff(45, 142, 12.5, 18, 9, 0.62, 0.2)}" fill="url(#puff-fur)" stroke="${FUR.shade}" stroke-width="1.2"/></g>
  <g class="m-arm m-arm-r"><path d="${fluff(155, 142, 12.5, 18, 9, 0.62, 0.5)}" fill="url(#puff-fur)" stroke="${FUR.shade}" stroke-width="1.2"/></g>
  <g class="m-head">
    <g class="m-antenna">
      <path d="M100 46C100 32 105 25 112 21" fill="none" stroke="${FUR.deep}" stroke-width="4" stroke-linecap="round"/>
      <circle class="m-tip-glow" cx="114" cy="18" r="12"/>
      <circle class="m-tip" cx="114" cy="18" r="6.5"/>
      <circle cx="112" cy="16" r="2" fill="#fff" opacity=".7"/>
    </g>
    <g class="m-ears">
      <path d="${fluff(57, 52, 15, 15, 9, 0.62, 0.1)}" fill="${FUR.shade}"/>
      <circle cx="58" cy="53" r="7" fill="#F8C3B2"/>
      <path d="${fluff(143, 52, 15, 15, 9, 0.62, 0.4)}" fill="${FUR.shade}"/>
      <circle cx="142" cy="53" r="7" fill="#F8C3B2"/>
    </g>
    <path d="${fluff(100, 90, 57, 50, 22, 0.6, 0.05)}" fill="${FUR.shade}"/>
    <path d="${fluff(100, 88, 54, 47, 24, 0.6, 0.3)}" fill="url(#puff-fur)"/>
    <path d="M70 52q5-6 11-3M118 47q7-4 13 1M56 108q-2 8 3 14M144 106q3 8-2 15" fill="none" stroke="${FUR.shade}" stroke-width="2" stroke-linecap="round" opacity=".8"/>
    <ellipse cx="100" cy="93" rx="38.5" ry="31" fill="url(#puff-face)"/>
    <ellipse cx="73" cy="104" rx="7.5" ry="4.8" fill="${CHEEK}" opacity=".55"/>
    <ellipse cx="127" cy="104" rx="7.5" ry="4.8" fill="${CHEEK}" opacity=".55"/>
    <g class="m-eyes-open">
      <g class="m-eye"><ellipse cx="85" cy="91" rx="5.2" ry="6.8" fill="${INK}"/><circle cx="86.9" cy="88.2" r="2" fill="#fff"/></g>
      <g class="m-eye"><ellipse cx="115" cy="91" rx="5.2" ry="6.8" fill="${INK}"/><circle cx="116.9" cy="88.2" r="2" fill="#fff"/></g>
    </g>
    <path class="m-eyes-happy" d="M79 93Q85 84 91 93M109 93Q115 84 121 93" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>
    <path class="m-eyes-sleep" d="M79 91Q85 97 91 91M109 91Q115 97 121 91" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
    <path class="m-mouth-smile" d="M94 103Q100 109 106 103" fill="none" stroke="${MOUTH}" stroke-width="3" stroke-linecap="round"/>
    <g class="m-mouth-open"><path d="M92 101Q100 116 108 101Z" fill="${MOUTH}"/><path d="M96.5 107.5Q100 111 103.500 107.5Q100 105.500 96.5 107.5Z" fill="#FF8FA0"/></g>
    <ellipse class="m-mouth-o" cx="100" cy="105" rx="2.8" ry="3.2" fill="${MOUTH}"/>
    <g class="m-phones">
      <path d="M43 92C43 18 157 18 157 92" fill="none" stroke="var(--m-accent,#4F8BFF)" stroke-width="7" stroke-linecap="round"/>
      <rect x="32" y="76" width="20" height="36" rx="10" fill="var(--m-accent-deep,#2F6BE6)"/>
      <rect x="148" y="76" width="20" height="36" rx="10" fill="var(--m-accent-deep,#2F6BE6)"/>
      <rect x="36" y="82" width="5" height="24" rx="2.5" fill="#fff" opacity=".35"/>
    </g>
  </g>
  <g class="m-laptop">
    <rect x="61" y="133" width="78" height="47" rx="8" fill="url(#puff-lid)" stroke="#B4BDCD" stroke-width="1.2"/>
    <circle class="m-lid-dot" cx="100" cy="156" r="6"/>
    <rect x="50" y="178" width="100" height="8" rx="4" fill="#AEB7C8"/>
  </g>
  <g class="m-bang">
    <path d="M150 52l-8 12 14-6z" fill="var(--warn-solid,#F59E0B)"/>
    <circle cx="164" cy="38" r="17" fill="var(--warn-solid,#F59E0B)"/>
    <rect x="161.500" y="26" width="5" height="15" rx="2.5" fill="#fff"/><circle cx="164" cy="46.5" r="3" fill="#fff"/>
  </g>
</g>`;
  }

  /* ---------- small head avatar (64 x 64) ---------- */
  function miniInner() {
    return `
<g class="mi-all">
  <path d="M32 15C32 10 34 7.5 36.500 6.500" fill="none" stroke="${FUR.deep}" stroke-width="2" stroke-linecap="round"/>
  <circle class="mi-tip" cx="37.500" cy="5.500" r="3.200"/>
  <path d="${fluff(16, 19, 7, 7, 8, 0.62, 0.1)}" fill="${FUR.shade}"/><circle cx="16.500" cy="19.500" r="3.200" fill="#F8C3B2"/>
  <path d="${fluff(48, 19, 7, 7, 8, 0.62, 0.4)}" fill="${FUR.shade}"/><circle cx="47.500" cy="19.500" r="3.200" fill="#F8C3B2"/>
  <path d="${fluff(32, 37, 26, 23.500, 18, 0.6, 0.05)}" fill="${FUR.shade}"/>
  <path d="${fluff(32, 36, 24.500, 22, 19, 0.6, 0.3)}" fill="url(#puff-fur)"/>
  <ellipse cx="32" cy="38.500" rx="17.500" ry="14.200" fill="url(#puff-face)"/>
  <ellipse cx="19.800" cy="43.500" rx="3.400" ry="2.200" fill="${CHEEK}" opacity=".55"/>
  <ellipse cx="44.200" cy="43.500" rx="3.400" ry="2.200" fill="${CHEEK}" opacity=".55"/>
  <g class="mi-eyes-open">
    <g class="mi-eye"><ellipse cx="25.200" cy="37.500" rx="2.500" ry="3.300" fill="${INK}"/><circle cx="26.100" cy="36.200" r="1" fill="#fff"/></g>
    <g class="mi-eye"><ellipse cx="38.800" cy="37.500" rx="2.500" ry="3.300" fill="${INK}"/><circle cx="39.700" cy="36.200" r="1" fill="#fff"/></g>
  </g>
  <path class="mi-eyes-happy" d="M22.400 38.600Q25.200 34.400 28 38.600M36 38.600Q38.800 34.400 41.600 38.600" fill="none" stroke="${INK}" stroke-width="1.800" stroke-linecap="round"/>
  <path class="mi-eyes-sleep" d="M22.400 37.600Q25.200 40.600 28 37.600M36 37.600Q38.800 40.600 41.600 37.600" fill="none" stroke="${INK}" stroke-width="1.700" stroke-linecap="round"/>
  <path d="M29.200 43.400Q32 46.200 34.800 43.400" fill="none" stroke="${MOUTH}" stroke-width="1.600" stroke-linecap="round"/>
  <g class="mi-phones">
    <path d="M6.500 38C6.500 3 57.500 3 57.500 38" fill="none" stroke="var(--hp,#4F8BFF)" stroke-width="3.400" stroke-linecap="round"/>
    <rect x="1.500" y="30" width="9.500" height="17" rx="4.700" fill="var(--hp-deep,#2F6BE6)"/>
    <rect x="53" y="30" width="9.500" height="17" rx="4.700" fill="var(--hp-deep,#2F6BE6)"/>
  </g>
</g>`;
  }

  function hero(state) {
    return `<svg class="mascot" viewBox="0 0 200 200" data-state="${state || 'idle'}" aria-hidden="true" focusable="false">${heroInner()}</svg>`;
  }

  function mini(state) {
    return `<svg class="mini" viewBox="0 0 64 64" data-state="${state || 'run'}" aria-hidden="true" focusable="false">${miniInner()}</svg>`;
  }

  // Stand-alone SVG for the app / tray icon (no CSS available there, so states are baked in).
  function iconSvg(size, badge) {
    const dot = badge
      ? `<circle cx="206" cy="206" r="42" fill="#fff"/><circle cx="206" cy="206" r="32" fill="${badge}"/>`
      : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
<defs>${DEFS}<style>.mi-eyes-happy,.mi-eyes-sleep,.mi-phones{display:none}.mi-tip{fill:#FFD166}</style></defs>
<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#puff-icon-bg)"/>
<circle cx="70" cy="60" r="60" fill="#fff" opacity=".12"/>
<g transform="translate(22 30) scale(3.3)">${miniInner()}</g>${dot}</svg>`;
  }

  function installDefs() {
    if (document.getElementById('puff-defs')) return;
    const holder = document.createElement('div');
    holder.innerHTML = `<svg id="puff-defs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${DEFS}</defs></svg>`;
    document.body.insertBefore(holder.firstChild, document.body.firstChild);
  }

  global.Puff = { hero, mini, iconSvg, installDefs };
})(window);
