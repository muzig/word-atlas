import { Check, ChevronLeft, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import { createProfile, DEFAULT_PROFILE, deleteProfile, profileSummary, renameProfile, store, useStore, type Profile } from "../store/store";
import { toast } from "./Toast";

const HUES = ["terra", "sage", "sky", "plum", "ochre"] as const;

/**
 * Colors go round in creation order. Deleted profiles stay in the list as tombstones,
 * so a deletion never recolors the others, and every device agrees on the order.
 */
function useHue(id: string) {
  const profiles = useStore((s) => s.profiles);
  const i = profiles.findIndex((p) => p.id === id);
  return HUES[(i < 0 ? profiles.length : i) % HUES.length];
}

export function Avatar({ profile, size = 32 }: { profile: Pick<Profile, "id" | "name">; size?: number }) {
  const hue = useHue(profile.id);
  return (
    <span className={`avatar avatar-${hue}`} style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {Array.from(profile.name.trim())[0] ?? "?"}
    </span>
  );
}

type Mode = "list" | "new" | "manage";

/** Top-bar avatar: who is learning right now, and a one-tap switch to another profile. */
export function ProfileSwitcher() {
  const atlas = useAtlas();
  const profiles = useStore((s) => s.profiles);
  const active = useStore((s) => s.profile);
  // Re-read summaries whenever progress changes while the panel is open.
  useStore((s) => s.progress);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const box = useRef<HTMLDivElement>(null);
  const list = profiles.filter((p) => !p.deleted);
  const current = list.find((p) => p.id === active) ?? list[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setMode("list");
  }, [open]);

  const pick = (p: Profile) => {
    setOpen(false);
    if (p.id === active) return;
    store.useProfile(p.id);
    toast(`已切换到「${p.name}」`, "ok");
  };

  return (
    <div className="prof" ref={box}>
      <button className="prof-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`学习档案：${current.name}，点击切换`} title={`学习档案：${current.name}`}>
        <Avatar profile={current} size={30} />
      </button>
      {open && (
        <div className="prof-pop" role="dialog" aria-label="学习档案">
          {mode === "list" && (
            <>
              <p className="eyebrow">切换学习档案</p>
              <ul className="prof-list">
                {list.map((p) => {
                  const s = profileSummary(p.id);
                  const on = p.id === active;
                  return (
                    <li key={p.id}>
                      <button className={on ? "is-on" : ""} onClick={() => pick(p)} aria-current={on}>
                        <Avatar profile={p} size={36} />
                        <span className="prof-text">
                          <b>{p.name}</b>
                          <small>
                            {s.known
                              ? `${atlas.cefr[s.startLevel] ?? atlas.cefr[0]} 起 · 已学 ${s.learned}${s.dueToday ? ` · 待复习 ${s.dueToday}` : ""}`
                              : "这台设备上还没打开过"}
                          </small>
                        </span>
                        {on && <Check size={17} className="prof-check" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="prof-foot">
                <button onClick={() => setMode("new")}>
                  <Plus size={17} /> 新建档案
                </button>
                <button onClick={() => setMode("manage")}>
                  <Settings2 size={17} /> 管理
                </button>
              </div>
              {list.length === 1 && <p className="prof-note">给家人各建一个档案，或按难度分开练，进度和设置互不影响。</p>}
            </>
          )}
          {mode === "new" && <NewProfile onBack={() => setMode("list")} onDone={() => setOpen(false)} />}
          {mode === "manage" && <ManageProfiles list={list} active={active} onBack={() => setMode("list")} />}
        </div>
      )}
    </div>
  );
}

function Back({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="prof-head">
      <button className="icon-btn" onClick={onBack} aria-label="返回">
        <ChevronLeft size={18} />
      </button>
      <p className="eyebrow">{title}</p>
    </div>
  );
}

function NewProfile({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const n = name.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!n) return;
        createProfile(n);
        onDone();
        toast(`已创建「${n.slice(0, 20)}」，先选一下起始难度`, "ok");
      }}
    >
      <Back title="新建档案" onBack={onBack} />
      <div className="prof-new">
        <Avatar profile={{ id: n || "new", name: n || "+" }} size={44} />
        <input autoFocus value={name} maxLength={20} placeholder="名字，比如「妈妈」或「雅思冲刺」" onChange={(e) => setName(e.target.value)} aria-label="档案名称" />
      </div>
      <p className="prof-note">新档案从零开始，有自己的进度和设置。创建后会切换过去，并让你选择起始难度和每日新词数。</p>
      <button className="btn btn-primary prof-submit" type="submit" disabled={!n}>
        创建并切换
      </button>
    </form>
  );
}

function ManageProfiles({ list, active, onBack }: { list: Profile[]; active: string; onBack: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      <Back title="管理档案" onBack={onBack} />
      <ul className="prof-manage">
        {list.map((p) =>
          confirming === p.id ? (
            <li key={p.id} className="prof-confirm">
              <p>
                删除「{p.name}」和它的全部学习记录？
                <br />
                <small>无法撤销，其他设备上也会一起删除。</small>
              </p>
              <div>
                <button className="btn btn-ghost" onClick={() => setConfirming(null)}>
                  取消
                </button>
                <button
                  className="btn btn-ghost btn-danger"
                  onClick={() => {
                    deleteProfile(p.id);
                    setConfirming(null);
                    toast(`已删除「${p.name}」`);
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          ) : (
            <li key={p.id}>
              <Avatar profile={p} size={32} />
              <input
                defaultValue={p.name}
                maxLength={20}
                aria-label={`${p.name} 的名称`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v) e.target.value = p.name;
                  else if (v !== p.name) renameProfile(p.id, v);
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <button
                className="icon-btn"
                onClick={() => setConfirming(p.id)}
                disabled={p.id === DEFAULT_PROFILE || p.id === active}
                aria-label={`删除 ${p.name}`}
                title={p.id === DEFAULT_PROFILE ? "默认档案不能删除" : p.id === active ? "正在使用的档案不能删除，先切换到别的档案" : `删除 ${p.name}`}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ),
        )}
      </ul>
      <p className="prof-note">点名字直接改名。正在使用的档案和默认档案不能删除。</p>
    </>
  );
}
