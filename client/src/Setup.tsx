import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function Setup() {
  const [searchParams] = useSearchParams();
  const [name, setName] = useState('');
  const [code, setCode] = useState((searchParams.get('room') || '').toUpperCase());
  const [inviteMode, setInviteMode] = useState<boolean>(!!searchParams.get('room'));
  const [avatar, setAvatar] = useState<{ bg: string; emoji?: string; initial?: string }>({ bg: '#FFE8A3', emoji: '🎉' });
  const navigate = useNavigate();

  const EMOJI_SET = useMemo(() => ['🐷','😎','🤖','🐱','🐶','🦊','🐼','🐵','🐧','🦄','🐯','🐸','🐨','🦁','🐰','🐹','🐻','🐤','🐙','🐳'], []);

  useEffect(() => {
    try {
      const savedName = localStorage.getItem('zoodle_name');
      if (savedName) setName(savedName);

      const room = searchParams.get('room');
      if (room) {
        setInviteMode(true);
        setCode(room.toUpperCase());
        // If no saved name, keep empty to force user to enter; otherwise keep saved
        if (!savedName) setName('');
      }

      const savedAvatar = localStorage.getItem('zoodle_avatar');
      if (savedAvatar) setAvatar(JSON.parse(savedAvatar));
    } catch {}
  }, [searchParams]);

  function generateCode() {
    const c = Math.random().toString(36).substring(2, 7).toUpperCase();
    setCode(c);
    setInviteMode(false);
  }

  function proceed() {
    if (!name || !code) return;
    try {
      localStorage.setItem('zoodle_name', name);
      localStorage.setItem('zoodle_avatar', JSON.stringify(avatar));
    } catch {}
    navigate(`/room?room=${encodeURIComponent(code)}`);
  }

  return (
    <div className="app" style={{ minHeight: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr' }}>
      <header className="header">
        <div className="branding">Zoodle</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={generateCode}>New Code</button>
        </div>
      </header>

      <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="form" style={{ width: 420, maxWidth: '94vw' }}>
          <div className="section-title">Profile</div>
          <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} autoFocus={!name} />
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
          <input placeholder="Room code" value={code}
                 readOnly={inviteMode}
                 onChange={e => { if (inviteMode) return; setCode(e.target.value.toUpperCase()); }} />
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
            <button className="btn btn-primary" onClick={proceed} disabled={!name || !code}>Continue</button>
            {!name || !code ? <small style={{ color:'#94a3b8' }}>Enter name and room code</small> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
