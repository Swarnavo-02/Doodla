import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function Setup() {
  const [searchParams] = useSearchParams();
  const [name, setName] = useState('');
  const [code, setCode] = useState(searchParams.get('room') || '');
  const [avatar, setAvatar] = useState<{ bg: string; emoji?: string; initial?: string }>({ bg: '#FFE8A3', emoji: '🎉' });
  const navigate = useNavigate();

  const EMOJI_SET = useMemo(() => ['🎉','😎','🤖','🐱','🐶','🦊','🐼','🐵','🐧','🦄','🐯','🐸','🐨','🦁','🐰','🐹','🐻','🐤','🐙','🐳'], []);

  useEffect(() => {
    try {
      const savedName = localStorage.getItem('scribal_name');
      const savedAvatar = localStorage.getItem('scribal_avatar');
      if (savedName) setName(savedName);
      if (savedAvatar) setAvatar(JSON.parse(savedAvatar));
    } catch {}
  }, []);

  function generateCode() {
    const c = Math.random().toString(36).substring(2, 7).toUpperCase();
    setCode(c);
  }

  function proceed() {
    if (!name || !code) return;
    try {
      localStorage.setItem('scribal_name', name);
      localStorage.setItem('scribal_avatar', JSON.stringify(avatar));
    } catch {}
    navigate(`/room?room=${encodeURIComponent(code)}`);
  }

  return (
    <div className="app" style={{ minHeight: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr' }}>
      <header className="header">
        <div className="branding">Scribal</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={generateCode}>New Code</button>
        </div>
      </header>

      <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="form" style={{ width: 420, maxWidth: '94vw' }}>
          <div className="section-title">Profile</div>
          <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
          <div style={{ display:'grid', gap:8 }}>
            <div className="section-title">Choose Avatar</div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div className="avatar" style={{ background: avatar.bg }}>{avatar.emoji || (name ? name[0].toUpperCase() : '🙂')}</div>
              <input type="color" value={avatar.bg} onChange={e => setAvatar(v => ({ ...v, bg: e.target.value }))} title="Background color" />
            </div>
            <div className="emoji-grid">
              {EMOJI_SET.map(em => (
                <button type="button" key={em} className={`emoji-btn ${avatar.emoji === em ? 'active' : ''}`} onClick={() => setAvatar(v => ({ ...v, emoji: em }))}>{em}</button>
              ))}
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 10 }}>Room</div>
          <input placeholder="Room code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />

          <button className="button-primary" onClick={proceed} style={{ marginTop: 8 }}>Continue</button>
        </div>
      </div>
    </div>
  );
}
