---------------------------- MODULE RunSync ----------------------------
(***************************************************************************)
(* As-is run model across the network (run#A.3, A.5-A.7, sc#A.2, sc#A.9,   *)
(* and the provisional rules of #143 / #145 / #147 / #149).                *)
(*                                                                         *)
(* Run.tla treats `result` and `finish` as atomic and the Host as the only *)
(* actor. Here the Host (packages/domain/src/run.ts) and the server        *)
(* (turns.ts / results.ts / finish.ts, run-record.ts `summarizeRun`) are   *)
(* separate, joined by requests that can be reordered, lost and rejected.  *)
(*                                                                         *)
(* Question: does the frozen record agree with the run the player saw?     *)
(*                                                                         *)
(* Abstractions: iframe states are folded into "pending" (slot properties  *)
(* F1-F5 stay in Run.tla). A turn outcome is its kind (ok / miss / skip).  *)
(* Responses are not lost: a lost response is followed by a retry that     *)
(* gets 409, which the Host treats as settled, so only request loss        *)
(* changes anything.                                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Cap,      \* turn limit (50 in prod)
  Lives,    \* 3
  Retries,  \* resends of `result` before the Host gives up (2 in prod)
  Loss,     \* BOOLEAN: a `result` request can be lost
  Reject,   \* BOOLEAN: the server can refuse a result (expired, sc#A.2)
  Abort,    \* BOOLEAN: the Host can abort (hidden 10 min, run#A.9)
  Vanish,   \* BOOLEAN: the page can close without calling finish
  PrefixRule \* BOOLEAN: FALSE = as-is (a turn without a result that has a
             \* later result counts as a miss or a skip, run#A.7). TRUE = the
             \* smallest repair: the record stops at the first turn without a
             \* result, for both `next` and `finish`

Turns == 1..Cap
Kinds == {"ok", "miss", "skip"}

VARIABLES
  \* --- server ---
  sess,      \* turn -> "none" | "open" | "ok" | "miss" | "skip"
  thr,       \* turn -> BOOLEAN: miss_below is non-null (frozen at issue)
  sEnded,    \* finish was processed
  sReached,  \* frozen at finish
  sEndKind,  \* frozen at finish: "lives" | "limit" | "abandoned"
  \* --- network ---
  nextReq,   \* number of `next` requests in flight
  nextResp,  \* issued turns on their way to the Host (a set: can be reordered)
  doneResp,  \* number of {done: true} responses on their way
  \* --- host ---
  requesting,\* `next` calls without a response yet
  pending,   \* prefetched turns (slots N+1, N+2)
  hNext,     \* next turn number to start or skip
  cur,       \* running turn, 0 between turns
  hKind,     \* turn -> "none" | kind: what the player saw
  hThr,      \* turn -> BOOLEAN: threshold the Host received
  lives,
  hDone,     \* server answered {done: true}
  phase,     \* "play" | "closing" | "finished" | "gone"
  aborted,
  out,       \* turn -> "none" | "wait" | "settled" | "gaveup"
  fails      \* turn -> number of lost sends

vars == << sess, thr, sEnded, sReached, sEndKind, nextReq, nextResp, doneResp,
           requesting, pending, hNext, cur, hKind, hThr, lives, hDone, phase, aborted, out, fails >>

sVars == << sess, thr, sEnded, sReached, sEndKind >>
hVars == << requesting, pending, hNext, cur, hKind, hThr, lives, hDone, phase, aborted, out, fails >>

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

(***************************************************************************)
(* summarizeRun (run-record.ts, sc#A.9, run#A.7)                           *)
(***************************************************************************)
Issued == Cardinality({t \in Turns : sess[t] # "none"})
Reported == {t \in Turns : sess[t] \in Kinds}
LastReported == IF Reported = {} THEN 0 ELSE Max(Reported)
PrefixLen == Cardinality({t \in Turns : \A u \in 1..t : sess[u] \in Kinds})
\* how far the server looks
Horizon == IF PrefixRule THEN PrefixLen ELSE LastReported
\* as-is: a turn without a result that has a later result counts as a miss
\* when it had a threshold, as a skip otherwise
Eff(t) == IF sess[t] \in Kinds THEN sess[t]
          ELSE IF t <= Horizon THEN (IF thr[t] THEN "miss" ELSE "skip")
          ELSE "none"
MissesUpTo(t) == Cardinality({u \in 1..t : Eff(u) = "miss"})
Over == \E t \in 1..Horizon : MissesUpTo(t) >= Lives
Reached == IF Over
           THEN Min({t \in 1..Horizon : MissesUpTo(t) >= Lives})
           ELSE Horizon
EndKind == IF Over THEN "lives" ELSE IF Reached >= Cap THEN "limit" ELSE "abandoned"

Init ==
  /\ sess = [t \in Turns |-> "none"] /\ thr = [t \in Turns |-> FALSE]
  /\ sEnded = FALSE /\ sReached = 0 /\ sEndKind = "none"
  /\ nextReq = 2 /\ nextResp = {} /\ doneResp = 0
  /\ requesting = 2 /\ pending = {} /\ hNext = 1 /\ cur = 0
  /\ hKind = [t \in Turns |-> "none"] /\ hThr = [t \in Turns |-> FALSE]
  /\ lives = Lives /\ hDone = FALSE /\ phase = "play" /\ aborted = FALSE
  /\ out = [t \in Turns |-> "none"] /\ fails = [t \in Turns |-> 0]

(***************************************************************************)
(* Server                                                                  *)
(***************************************************************************)
\* POST /runs/{id}/next (turns.ts). Misses are counted like finish (#143-5).
ServerNext ==
  /\ nextReq > 0 /\ nextReq' = nextReq - 1
  /\ IF sEnded \/ Issued >= Cap \/ MissesUpTo(Horizon) >= Lives
     THEN /\ doneResp' = doneResp + 1
          /\ UNCHANGED << sVars, nextResp >>
     ELSE \E th \in BOOLEAN :
            /\ sess' = [sess EXCEPT ![Issued + 1] = "open"]
            /\ thr' = [thr EXCEPT ![Issued + 1] = th]
            /\ nextResp' = nextResp \cup {Issued + 1}
            /\ UNCHANGED << sEnded, sReached, sEndKind, doneResp >>
  /\ UNCHANGED hVars

\* PUT /sessions/{id}/result arrives (results.ts). A refused result leaves
\* the session `skipped` (#145-4). Not open -> 409. The Host treats every
\* response as settled (run.ts `result_settled`).
ResultArrive(t) ==
  /\ out[t] = "wait"
  /\ out' = [out EXCEPT ![t] = "settled"]
  /\ IF sess[t] = "open" /\ ~sEnded
     THEN \/ sess' = [sess EXCEPT ![t] = hKind[t]]
          \/ Reject /\ sess' = [sess EXCEPT ![t] = "skip"]
     ELSE sess' = sess
  /\ UNCHANGED << thr, sEnded, sReached, sEndKind, nextReq, nextResp, doneResp, requesting,
                  pending, hNext, cur, hKind, hThr, lives, hDone, phase, aborted, fails >>

\* The request is lost. The Host resends up to Retries times, then gives up
\* (run#A.7; run.ts `result_failed`).
ResultLost(t) ==
  /\ Loss /\ out[t] = "wait"
  /\ IF fails[t] >= Retries
     THEN out' = [out EXCEPT ![t] = "gaveup"] /\ fails' = fails
     ELSE fails' = [fails EXCEPT ![t] = fails[t] + 1] /\ out' = out
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, pending, hNext, cur, hKind,
                  hThr, lives, hDone, phase, aborted >>

(***************************************************************************)
(* Host (run.ts)                                                           *)
(***************************************************************************)
\* refill: keep two turns ahead
HostRequest ==
  /\ phase = "play" /\ ~hDone
  /\ Cardinality(pending) + requesting < 2
  /\ requesting' = requesting + 1 /\ nextReq' = nextReq + 1
  /\ UNCHANGED << sVars, nextResp, doneResp, pending, hNext, cur, hKind, hThr, lives, hDone,
                  phase, aborted, out, fails >>

HostRecvNext(m) ==
  /\ m \in nextResp /\ nextResp' = nextResp \ {m}
  /\ requesting' = requesting - 1
  /\ IF phase = "play"
     THEN pending' = pending \cup {m} /\ hThr' = [hThr EXCEPT ![m] = thr[m]]
     ELSE UNCHANGED << pending, hThr >>
  /\ UNCHANGED << sVars, nextReq, doneResp, hNext, cur, hKind, lives, hDone, phase,
                  aborted, out, fails >>

\* {done: true} is sticky on the Host: it never asks again (run.ts `serverDone`)
HostRecvDone ==
  /\ doneResp > 0 /\ doneResp' = doneResp - 1
  /\ requesting' = requesting - 1 /\ hDone' = TRUE
  /\ UNCHANGED << sVars, nextReq, nextResp, pending, hNext, cur, hKind, hThr, lives,
                  phase, aborted, out, fails >>

\* the head of the queue is startable only when it is the next turn number
\* (responses can be reordered; PR #150)
HeadReady == pending # {} /\ (Min(pending) = hNext \/ requesting = 0)

\* interlude end: start (A.5 step 5)
HostStart ==
  /\ phase = "play" /\ cur = 0 /\ HeadReady /\ lives > 0
  /\ cur' = Min(pending) /\ pending' = pending \ {Min(pending)}
  /\ hNext' = Min(pending) + 1
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, hKind, hThr, lives, hDone,
                  phase, aborted, out, fails >>

\* interlude extension ran out: load skip, report {skipped: true} (A.5 step 6, A.6)
HostSkipLoad ==
  /\ phase = "play" /\ cur = 0 /\ HeadReady
  /\ LET t == Min(pending) IN
       /\ pending' = pending \ {t} /\ hNext' = t + 1
       /\ hKind' = [hKind EXCEPT ![t] = "skip"]
       /\ out' = [out EXCEPT ![t] = "wait"]
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, cur, hThr, lives, hDone,
                  phase, aborted, fails >>

\* the running turn ends; miss judged on the spot with the frozen threshold
HostEnd ==
  /\ phase = "play" /\ cur # 0
  /\ \E k \in Kinds :
       /\ (k = "miss" => hThr[cur])
       /\ hKind' = [hKind EXCEPT ![cur] = k]
       /\ lives' = IF k = "miss" THEN lives - 1 ELSE lives
       /\ phase' = IF k = "miss" /\ lives = 1 THEN "closing" ELSE "play"
       /\ pending' = IF k = "miss" /\ lives = 1 THEN {} ELSE pending
  /\ out' = [out EXCEPT ![cur] = "wait"]
  /\ cur' = 0
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, hNext, hThr, hDone, aborted, fails >>

\* the server said done and nothing is left to play
HostNoMore ==
  /\ phase = "play" /\ cur = 0 /\ pending = {} /\ hDone /\ requesting = 0
  /\ phase' = "closing"
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, pending, hNext, cur, hKind,
                  hThr, lives, hDone, aborted, out, fails >>

\* hidden for 10 minutes (A.9). The turn on screen is dropped without a result.
HostAbort ==
  /\ Abort /\ phase = "play"
  /\ phase' = "closing" /\ aborted' = TRUE /\ pending' = {} /\ cur' = 0
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, hNext, hKind, hThr, lives,
                  hDone, out, fails >>

\* the page is closed: no finish
HostVanish ==
  /\ Vanish /\ phase \in {"play", "closing"}
  /\ phase' = "gone" /\ aborted' = TRUE /\ pending' = {} /\ cur' = 0
  /\ out' = [t \in Turns |-> IF out[t] = "wait" THEN "gaveup" ELSE out[t]]
  /\ UNCHANGED << sVars, nextReq, nextResp, doneResp, requesting, hNext, hKind, hThr, lives,
                  hDone, fails >>

\* finish once every sent result is settled or given up (#149-4). The
\* server freezes the record (finish.ts).
HostFinish ==
  /\ phase = "closing" /\ \A t \in Turns : out[t] # "wait"
  /\ phase' = "finished"
  /\ sEnded' = TRUE /\ sReached' = Reached /\ sEndKind' = EndKind
  /\ UNCHANGED << sess, thr, nextReq, nextResp, doneResp, requesting, pending, hNext, cur,
                  hKind, hThr, lives, hDone, aborted, out, fails >>

Next ==
  \/ ServerNext \/ HostRequest \/ HostRecvDone \/ \E m \in nextResp : HostRecvNext(m)
  \/ \E t \in Turns : ResultArrive(t) \/ ResultLost(t)
  \/ HostStart \/ HostSkipLoad \/ HostEnd \/ HostNoMore \/ HostAbort \/ HostVanish
  \/ HostFinish

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(***************************************************************************)
(* Properties. "What the player saw" is hKind and the Host's reason to end. *)
(***************************************************************************)
Played == {t \in Turns : hKind[t] # "none"}
HostReached == IF Played = {} THEN 0 ELSE Max(Played)
HostEndKind == IF lives = 0 THEN "lives" ELSE IF HostReached >= Cap THEN "limit" ELSE "abandoned"

TypeOK == /\ lives \in 0..Lives /\ Cardinality(pending) <= 2 /\ cur \in 0..Cap

\* A1: the frozen number of turns is the number the player saw
A1 == phase = "finished" => sReached = HostReached
\* A2: every turn in the record has the outcome the player saw
A2 == phase = "finished" => \A t \in 1..sReached : Eff(t) = hKind[t]
\* A3: the record ends for the reason the player saw
A3 == phase = "finished" => sEndKind = HostEndKind
\* A4: the run stops only for a reason the player can see: out of lives,
\* the limit, or the player's own abort. The server never cuts it short.
A4 == phase \in {"closing", "finished"} => lives = 0 \/ HostReached >= Cap \/ aborted
\* A5 (weaker than A1+A2): the record is a prefix of what the player saw
A5 == phase = "finished" => sReached <= HostReached /\ \A t \in 1..sReached : Eff(t) = hKind[t]
\* A6: every run is eventually frozen on the server
A6 == <>sEnded
=============================================================================
