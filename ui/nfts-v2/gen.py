import math, sys

PAL = {
 "armed":    dict(f1="#f4e2a8", f2="#c9a24a", f3="#8a6420", f4="#ecd28a", acc="#d8b45c", dot="#d8b45c", bg1="#10131a", bg2="#07090d", status="ARMED"),
 "veteran":  dict(f1="#f3f6fa", f2="#aeb9c8", f3="#68758a", f4="#dfe6ee", acc="#bfcad9", dot="#9fd0c4", bg1="#0f141b", bg2="#06080c", status="ARMED · VETERAN"),
 "defeated": dict(f1="#c9ccd2", f2="#8b9099", f3="#4f545d", f4="#b5b9c1", acc="#9a9fa8", dot="#b5403f", bg1="#12141a", bg2="#08090c", status="RELEASED"),
}

def hypo(R, r, d, rot=0, n=2400, cx=0, cy=0, turns=None):
    k=(R-r)/r
    from fractions import Fraction
    fr=Fraction(R-r, r).limit_denominator(200)
    T = 2*math.pi*fr.denominator
    pts=[]
    for i in range(n+1):
        t=T*i/n
        x=(R-r)*math.cos(t)+d*math.cos(k*t)
        y=(R-r)*math.sin(t)-d*math.sin(k*t)
        a=math.radians(rot)
        xr=x*math.cos(a)-y*math.sin(a); yr=x*math.sin(a)+y*math.cos(a)
        pts.append(f"{cx+xr:.1f} {cy+yr:.1f}")
    return "M"+" L".join(pts)+"Z"

def rosette(cx, cy):
    g=""
    specs=[(172,58,64,0,.50),(172,58,64,60,.50),(172,58,64,120,.50),(150,50,42,30,.45),(150,50,42,90,.45),(120,41,30,0,.42),(120,41,30,60,.42),(92,31,24,15,.40)]
    for R,r,d,rot,op in specs:
        g+=f'<path d="{hypo(R,r,d,rot,1800,cx,cy)}" fill="none" stroke="url(#foil)" stroke-width=".55" stroke-opacity="{op}"/>'
    return g

def ticks(cx,cy):
    s=""
    for i in range(120):
        a=math.radians(i*3)
        major = i%10==0
        r1=214; r2=r1-(11 if major else 5)
        s+=f'<line x1="{cx+r1*math.cos(a):.1f}" y1="{cy+r1*math.sin(a):.1f}" x2="{cx+r2*math.cos(a):.1f}" y2="{cy+r2*math.sin(a):.1f}" stroke="url(#foil)" stroke-width="{1.2 if major else .6}" stroke-opacity="{.9 if major else .45}"/>'
    return s

def card(state, num, name, pot, attempts, streak, blocked, wins, hashs):
    p=PAL[state]; W,H=600,840; cx,cy=300,330
    defeated = state=="defeated"
    medal=f'''
    <g>
      <circle cx="{cx}" cy="{cy}" r="226" fill="none" stroke="url(#foil)" stroke-width="1" stroke-opacity=".6"/>
      <circle cx="{cx}" cy="{cy}" r="203" fill="none" stroke="url(#foil)" stroke-width="1" stroke-opacity=".5"/>
      <path id="mt" d="M {cx-214.5} {cy} a 214.5 214.5 0 1 1 429 0 a 214.5 214.5 0 1 1 -429 0" fill="none"/>
      <text font-family="Inter" font-size="6.6" font-weight="600" letter-spacing="2.2" fill="url(#foil)" fill-opacity=".85"><textPath href="#mt" textLength="1344" lengthAdjust="spacing">SEALED · ON-CHAIN · NEP-171 · THE VAULT HOLDS THE POT · THE AI CANNOT MOVE IT · VAULTBREAK · SEALED · ON-CHAIN · NEP-171 · THE VAULT HOLDS THE POT · THE AI CANNOT MOVE IT · VAULTBREAK ·</textPath></text>
      {ticks(cx,cy)}
      {rosette(cx,cy)}
      <circle cx="{cx}" cy="{cy}" r="74" fill="#0a0c11" stroke="url(#foil)" stroke-width="1.4"/>
      <circle cx="{cx}" cy="{cy}" r="66" fill="none" stroke="url(#foil)" stroke-width=".6" stroke-opacity=".7"/>
      <circle cx="{cx}" cy="{cy}" r="58" fill="none" stroke="url(#foil)" stroke-width=".5" stroke-opacity=".4" stroke-dasharray="1.2 3.2"/>
      <path d="M {cx-9.5} {cy+27} L {cx-4.5} {cy+3.5} A 14 14 0 1 1 {cx+4.5} {cy+3.5} L {cx+9.5} {cy+27} Z" fill="url(#foil)"/>
      <circle cx="{cx}" cy="{cy-8}" r="4.4" fill="#0a0c11"/>
    </g>'''
    if defeated:
        medal=f'''<clipPath id="ca"><polygon points="0,0 {cx+30},0 {cx-34},{H} 0,{H}"/></clipPath><clipPath id="cb"><polygon points="{cx+30},0 {W},0 {W},{H} {cx-34},{H}"/></clipPath>
        <g clip-path="url(#ca)" transform="translate(-5,3)">{medal}</g><g clip-path="url(#cb)" transform="translate(5,-3)">{medal}</g>
        <line x1="{cx+30}" y1="110" x2="{cx-34}" y2="555" stroke="#b5403f" stroke-width="1.2" stroke-opacity=".9"/>'''
    stamp=""
    if defeated:
        stamp=f'''<g transform="rotate(-9 {cx} {cy+8})"><rect x="{cx-112}" y="{cy-4}" width="224" height="40" rx="3" fill="#0b0c10" fill-opacity=".78" stroke="#b5403f" stroke-width="1.6"/>
        <text x="{cx}" y="{cy+22}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="15" letter-spacing="5" fill="#d0504d">POT RELEASED</text></g>'''
    rows=[("ATTEMPTS",attempts),("STREAK",streak),("BLOCKED",blocked),("WINS",wins)]
    rowsvg=""
    for i,(k,v) in enumerate(rows):
        y=690+i*26
        rowsvg+=f'<line x1="338" y1="{y-20}" x2="562" y2="{y-20}" stroke="#fff" stroke-opacity=".10"/><text x="338" y="{y}" font-family="Inter" font-size="10" font-weight="500" letter-spacing="2.2" fill="#8d95a3">{k}</text><text x="562" y="{y+1}" text-anchor="end" font-family="Inter" font-size="15" font-weight="600" fill="#eef1f6" style="font-variant-numeric:tabular-nums">{v}</text>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
 <linearGradient id="foil" gradientUnits="userSpaceOnUse" x1="60" y1="80" x2="540" y2="600"><stop offset="0" stop-color="{p['f1']}"/><stop offset=".35" stop-color="{p['f2']}"/><stop offset=".62" stop-color="{p['f3']}"/><stop offset="1" stop-color="{p['f4']}"/></linearGradient>
 <radialGradient id="bg" cx="50%" cy="36%" r="78%"><stop offset="0" stop-color="{p['bg1']}"/><stop offset="1" stop-color="{p['bg2']}"/></radialGradient>
 <radialGradient id="halo" cx="50%" cy="39%" r="46%"><stop offset="0" stop-color="{p['acc']}" stop-opacity=".10"/><stop offset="1" stop-color="{p['acc']}" stop-opacity="0"/></radialGradient>
 <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" result="n"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .055 0"/></filter>
</defs>
<rect width="{W}" height="{H}" rx="26" fill="url(#bg)"/>
<rect width="{W}" height="{H}" rx="26" fill="url(#halo)"/>
<rect width="{W}" height="{H}" rx="26" filter="url(#grain)"/>
<rect x="10" y="10" width="{W-20}" height="{H-20}" rx="19" fill="none" stroke="url(#foil)" stroke-width="1.4"/>
<rect x="17" y="17" width="{W-34}" height="{H-34}" rx="13" fill="none" stroke="url(#foil)" stroke-width=".5" stroke-opacity=".55"/>

<text x="42" y="62" font-family="Inter" font-size="12" font-weight="700" letter-spacing="4" fill="url(#foil)">VAULTBREAK</text>
<text x="{W-42}" y="62" text-anchor="end" font-family="Inter" font-size="11" font-weight="500" letter-spacing="2.6" fill="#8d95a3">GUARDIAN  <tspan fill="#eef1f6" font-weight="600">No. {num:04d}</tspan></text>
<line x1="42" y1="78" x2="{W-42}" y2="78" stroke="#fff" stroke-opacity=".10"/>

{medal}
{stamp}

<text x="42" y="618" font-family="Inter Display, Inter" font-size="31" font-weight="600" letter-spacing=".4" fill="#f2f4f8">{name}</text>
<circle cx="45" cy="640" r="3.4" fill="{p['dot']}"/>
<text x="56" y="644" font-family="Inter" font-size="10.5" font-weight="600" letter-spacing="2.8" fill="#aab2bf">{p['status']}</text>

<text x="42" y="690" font-family="Inter" font-size="10" font-weight="500" letter-spacing="2.2" fill="#8d95a3">POT</text>
<text x="42" y="730" font-family="Inter Display, Inter" font-size="38" font-weight="600" fill="#f2f4f8" style="font-variant-numeric:tabular-nums">{pot}<tspan font-size="15" font-weight="500" fill="#8d95a3" dx="6" letter-spacing="1.5">NEAR</tspan></text>
{rowsvg}
<line x1="42" y1="780" x2="{W-42}" y2="780" stroke="#fff" stroke-opacity=".10"/>
<text x="42" y="803" font-family="Inter" font-size="9.5" font-weight="500" letter-spacing="2" fill="#6f7886">SEALED PROMPT  <tspan fill="#aab2bf" font-family="DejaVu Sans Mono" letter-spacing=".6">{hashs}</tspan></text>
<text x="{W-42}" y="803" text-anchor="end" font-family="Inter" font-size="9.5" font-weight="500" letter-spacing="2" fill="#6f7886">NEP-171</text>
</svg>'''

D=sys.argv[1]
open(D+"/armed.svg","w").write(card("armed",42,"The Warden","201.65","12","12","3","0","fcbd7d…ce39"))
open(D+"/veteran.svg","w").write(card("veteran",113,"Silent Keep","1,008.68","214","25","37","0","c0d4a1…88f1"))
open(D+"/defeated.svg","w").write(card("defeated",7,"Old Ironside","0.00","61","0","11","1","5be2f0…04a9"))
