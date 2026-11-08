---------------------------- MODULE Session ----------------------------
(***************************************************************************)
(* Host-Guest session protocol (docs/protocol.md A.4 - A.10).              *)
(*                                                                         *)
(* Host and Guest run as separate processes joined by two FIFO channels    *)
(* (postMessage in each direction). The Host owns a monitor timer that is  *)
(* modelled as a discrete countdown: a tick is only possible while the     *)
(* Host is RUNNING, so the remaining time never changes in PAUSED (P13).   *)
(*                                                                         *)
(* Design switches (all TRUE = the adopted design, pr#B.4 - B.6):          *)
(*   CheckSid     Host matches session_id on end/error (pr#A.5)            *)
(*   EndInPaused  Host accepts end in PAUSED (pr#A.5, B.5)                 *)
(* PAUSED -> init is never offered because pr#A.6 forbids it; the old      *)
(* "paused ACK" (counterexample 3) has no counterpart in the new protocol. *)
(*                                                                         *)
(* Out of scope: `log` contents and frame counting (A.9), `ready` payload, *)
(* the Guest's own wall clock (it only means the Guest may or may not send *)
(* `end`; both are modelled as non-determinism).                           *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  MaxSid,       \* number of sessions the Host may start (init) in one run
  ChanLen,      \* bound on each FIFO channel
  TimerLen,     \* monitor timer length in ticks (pr#A.7)
  CheckSid,     \* BOOLEAN design switch
  EndInPaused   \* BOOLEAN design switch

ASSUME MaxSid \in Nat /\ ChanLen \in Nat /\ TimerLen \in Nat
ASSUME CheckSid \in BOOLEAN /\ EndInPaused \in BOOLEAN

Sids  == 1..MaxSid
Modes == {"play", "replay"}
Vias  == {"guest", "timeout", "error"}

VARIABLES
  \* --- Host ---
  hState,      \* LOADING READY INITED RUNNING PAUSED ENDED DESTROYED
  hSid,        \* current session id (0 = none)
  hMode,       \* mode of current session
  hTimer,      \* remaining ticks of the monitor timer
  hExpired,    \* set of sids whose monitor timer has expired (pr#A.7)
  hAccepted,   \* function sid -> number of accepted `end`s (P1)
  hScored,     \* set of sids whose `end` became a play record (P2)
  hDropped,    \* set of sids of `end` messages the Host discarded (P3, P4)
  hVia,        \* function sid -> via of the ENDED transition or "none"
  hModeOf,     \* function sid -> mode given in init (sids are never reused)
  hMismatch,   \* TRUE if an `end` was ever accepted with sid # hSid (P2)
  hExpireFrom, \* state the Host was in at the last timer expiry (P11)
  \* --- Guest ---
  gState,      \* LOADING READY INITED RUNNING PAUSED ENDED DESTROYED
  gSid,
  gMode,
  gErrored,    \* TRUE once `error` has been sent for gSid (pr#A.10)
  gSentEnd,    \* set of sids for which the Guest has sent `end`
  \* --- channels ---
  h2g, g2h     \* sequences of messages

vars == << hState, hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped,
           hVia, hModeOf, hMismatch, hExpireFrom,
           gState, gSid, gMode, gErrored, gSentEnd, h2g, g2h >>

HostStates == {"LOADING", "READY", "INITED", "RUNNING", "PAUSED", "ENDED", "DESTROYED"}

Init ==
  /\ hState = "LOADING" /\ hSid = 0 /\ hMode = "play" /\ hTimer = 0
  /\ hExpired = {} /\ hAccepted = [s \in Sids |-> 0] /\ hScored = {}
  /\ hDropped = {} /\ hVia = [s \in Sids |-> "none"] /\ hExpireFrom = "none"
  /\ hModeOf = [s \in Sids |-> "play"] /\ hMismatch = FALSE
  /\ gState = "LOADING" /\ gSid = 0 /\ gMode = "play" /\ gErrored = FALSE
  /\ gSentEnd = {}
  /\ h2g = << >> /\ g2h = << >>

hostVars  == << hState, hSid, hMode, hTimer, hExpired, hAccepted, hScored,
                hDropped, hVia, hModeOf, hMismatch, hExpireFrom >>
guestVars == << gState, gSid, gMode, gErrored, gSentEnd >>

(***************************************************************************)
(* Guest                                                                   *)
(***************************************************************************)
GuestReady ==
  /\ gState = "LOADING" /\ Len(g2h) < ChanLen
  /\ gState' = "READY"
  /\ g2h' = Append(g2h, [type |-> "ready"])
  /\ UNCHANGED << hostVars, gSid, gMode, gErrored, gSentEnd, h2g >>

\* The game calls GF.end() or the SDK reaches time_limit / wall clock (A.4).
\* Frames only advance in RUNNING, so `end` is only produced there.
GuestEnd ==
  /\ gState = "RUNNING" /\ ~gErrored /\ Len(g2h) < ChanLen
  /\ gState' = "ENDED"
  /\ gSentEnd' = gSentEnd \cup {gSid}
  /\ g2h' = Append(g2h, [type |-> "end", sid |-> gSid])   \* no mode on the wire (pr#A.3)
  /\ UNCHANGED << hostVars, gSid, gMode, gErrored, h2g >>

\* An exception in a callback (onInit in INITED, onTick/onDraw/onInput in
\* RUNNING). Sent once; the Guest then stays silent for this session (A.10).
GuestError ==
  /\ gState \in {"INITED", "RUNNING"} /\ ~gErrored /\ Len(g2h) < ChanLen
  /\ gErrored' = TRUE
  /\ gState' = "ENDED"
  /\ g2h' = Append(g2h, [type |-> "error", sid |-> gSid])
  /\ UNCHANGED << hostVars, gSid, gMode, gSentEnd, h2g >>

GuestRecv ==
  /\ Len(h2g) > 0
  /\ LET m == Head(h2g) IN
     /\ h2g' = Tail(h2g)
     /\ CASE gState = "DESTROYED" ->
             UNCHANGED guestVars
        [] m.type = "destroy" ->
             /\ gState' = "DESTROYED"
             /\ UNCHANGED << gSid, gMode, gErrored, gSentEnd >>
        [] m.type = "init" ->
             IF gState \in {"READY", "ENDED"}
                \/ (gState = "RUNNING" /\ gMode = "replay")
             THEN /\ gState' = "INITED" /\ gSid' = m.sid /\ gMode' = m.mode
                  /\ gErrored' = FALSE /\ UNCHANGED gSentEnd
             ELSE UNCHANGED guestVars
        [] m.type = "start" ->
             IF gState = "INITED"
             THEN gState' = "RUNNING" /\ UNCHANGED << gSid, gMode, gErrored, gSentEnd >>
             ELSE UNCHANGED guestVars
        [] m.type = "pause" ->
             IF gState = "RUNNING"
             THEN gState' = "PAUSED" /\ UNCHANGED << gSid, gMode, gErrored, gSentEnd >>
             ELSE UNCHANGED guestVars
        [] m.type = "resume" ->
             IF gState = "PAUSED"
             THEN gState' = "RUNNING" /\ UNCHANGED << gSid, gMode, gErrored, gSentEnd >>
             ELSE UNCHANGED guestVars
  /\ UNCHANGED << hostVars, g2h >>

(***************************************************************************)
(* Host: its own commands (A.5 table, Host -> Guest)                       *)
(***************************************************************************)
HostInit ==
  /\ hState \in {"READY", "ENDED"}
  /\ hSid < MaxSid /\ Len(h2g) < ChanLen
  /\ \E mode \in Modes :
       /\ hSid' = hSid + 1 /\ hMode' = mode /\ hState' = "INITED" /\ hTimer' = 0
       /\ hModeOf' = [hModeOf EXCEPT ![hSid + 1] = mode]
       /\ h2g' = Append(h2g, [type |-> "init", sid |-> hSid + 1, mode |-> mode])
  /\ UNCHANGED << hExpired, hAccepted, hScored, hDropped, hVia, hMismatch, hExpireFrom, guestVars, g2h >>

HostStart ==
  /\ hState = "INITED" /\ Len(h2g) < ChanLen
  /\ hState' = "RUNNING" /\ hTimer' = TimerLen
  /\ h2g' = Append(h2g, [type |-> "start"])
  /\ UNCHANGED << hSid, hMode, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom, guestVars, g2h >>

HostPause ==
  /\ hState = "RUNNING" /\ Len(h2g) < ChanLen
  /\ hState' = "PAUSED"
  /\ h2g' = Append(h2g, [type |-> "pause"])
  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom, guestVars, g2h >>

HostResume ==
  /\ hState = "PAUSED" /\ Len(h2g) < ChanLen
  /\ hState' = "RUNNING"
  /\ h2g' = Append(h2g, [type |-> "resume"])
  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom, guestVars, g2h >>

HostDestroy ==
  /\ hState # "DESTROYED" /\ Len(h2g) < ChanLen
  /\ hState' = "DESTROYED"
  /\ h2g' = Append(h2g, [type |-> "destroy"])
  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom, guestVars, g2h >>

(***************************************************************************)
(* Host: monitor timer (A.7). Time only passes while RUNNING.             *)
(***************************************************************************)
HostTick ==
  /\ hState = "RUNNING" /\ hTimer > 0
  /\ hTimer' = hTimer - 1
  /\ UNCHANGED << hState, hSid, hMode, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom, guestVars, h2g, g2h >>

HostExpire ==
  /\ hState = "RUNNING" /\ hTimer = 0
  /\ hExpireFrom' = hState
  /\ hState' = "ENDED"
  /\ hExpired' = hExpired \cup {hSid}
  /\ hVia' = [hVia EXCEPT ![hSid] = "timeout"]
  /\ UNCHANGED << hSid, hMode, hTimer, hAccepted, hScored, hDropped, hModeOf, hMismatch, guestVars, h2g, g2h >>

(***************************************************************************)
(* Host: messages from the Guest (A.5 table, Guest -> Host)                *)
(***************************************************************************)
SidOk(m) == ~CheckSid \/ m.sid = hSid

AcceptEnd(m) ==
  /\ hState \in (IF EndInPaused THEN {"RUNNING", "PAUSED"} ELSE {"RUNNING"})
  /\ SidOk(m)
  /\ hSid \notin hExpired

HostRecv ==
  /\ Len(g2h) > 0
  /\ LET m == Head(g2h) IN
     /\ g2h' = Tail(g2h)
     /\ CASE hState = "DESTROYED" ->
             UNCHANGED hostVars
        [] m.type = "ready" ->
             IF hState = "LOADING"
             THEN hState' = "READY"
                  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped, hVia, hModeOf, hMismatch, hExpireFrom >>
             ELSE UNCHANGED hostVars
        [] m.type = "end" ->
             IF AcceptEnd(m)
             THEN /\ hState' = "ENDED"
                  /\ hAccepted' = [hAccepted EXCEPT ![m.sid] = @ + 1]
                  \* the Host classifies by the mode it saved for its own session
                  /\ hScored' = IF hMode = "play" THEN hScored \cup {m.sid} ELSE hScored
                  /\ hVia' = [hVia EXCEPT ![m.sid] = "guest"]
                  /\ hMismatch' = hMismatch \/ m.sid # hSid
                  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hDropped, hModeOf, hExpireFrom >>
             ELSE /\ hDropped' = hDropped \cup {m.sid}
                  /\ UNCHANGED << hState, hSid, hMode, hTimer, hExpired, hAccepted, hScored, hVia, hModeOf, hMismatch, hExpireFrom >>
        [] m.type = "error" ->
             IF hState \in {"RUNNING", "PAUSED"} /\ SidOk(m)
             THEN /\ hState' = "ENDED"
                  /\ hVia' = [hVia EXCEPT ![m.sid] = "error"]
                  /\ UNCHANGED << hSid, hMode, hTimer, hExpired, hAccepted, hScored, hDropped, hModeOf, hMismatch, hExpireFrom >>
             ELSE UNCHANGED hostVars
  /\ UNCHANGED << guestVars, h2g >>

Next ==
  \/ GuestReady \/ GuestEnd \/ GuestError \/ GuestRecv
  \/ HostInit \/ HostStart \/ HostPause \/ HostResume \/ HostDestroy
  \/ HostTick \/ HostExpire \/ HostRecv

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties (pr#A.12)                                                    *)
(***************************************************************************)
TypeOK ==
  /\ hState \in HostStates /\ gState \in HostStates
  /\ hSid \in 0..MaxSid /\ gSid \in 0..MaxSid
  /\ hTimer \in 0..TimerLen
  /\ Len(h2g) <= ChanLen /\ Len(g2h) <= ChanLen

\* P1: at most one accepted `end` per session_id
P1 == \A s \in Sids : hAccepted[s] <= 1

\* P2: an accepted `end` belongs to the Host's current session, and only
\* play sessions become records (replay results never score). The wire `end`
\* carries no mode (pr#A.3); the Host decides from hMode, and P2 checks that
\* against the mode given in init for that sid.
P2 == ~hMismatch /\ \A s \in hScored : hModeOf[s] = "play"

\* P3: the Host drops an `end` of the *current* session only after expiry
P3 == hSid \in hDropped => hSid \in hExpired \/ hState = "DESTROYED"

\* P4: an `end` the Guest sent for a play session is not lost except by
\* destroy or timer expiry. "Lost" = dropped by the Host. Sids in hDropped
\* that are not current are old sessions; they must have expired too
\* (the Host only moves on from ENDED, and a non-expired ENDED session was
\* ended by an accepted `end` or an `error`, after which the Guest never
\* sends `end`).
P4 == \A s \in hDropped : s \in hExpired \/ hState = "DESTROYED"

\* P11: expiry happens only from RUNNING and only when the timer is at 0
\* (the second half is a guard of HostExpire; the first is recorded).
P11 == hExpireFrom \in {"none", "RUNNING"}

\* P12: no `end` is accepted for an expired session
P12 == \A s \in hExpired : hAccepted[s] = 0

Invariants == TypeOK /\ P1 /\ P2 /\ P3 /\ P4 /\ P11 /\ P12

\* P13: the remaining time never decreases while PAUSED
P13 == [][hState = "PAUSED" => hTimer' >= hTimer]_vars

=============================================================================
