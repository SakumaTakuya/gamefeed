------------------------------ MODULE Run ------------------------------
(***************************************************************************)
(* A run: turns, slots N..N+2, interlude, skip, lives (docs/run.md A.3-A.7) *)
(*                                                                         *)
(* One iframe per issued turn. Slot N is the displayed turn `cur`; N+1 and *)
(* N+2 are the prefetched turns cur+1, cur+2. Each iframe follows the Host *)
(* state machine of protocol.md A.5 but abstracted: LOADING -> READY ->    *)
(* INITED -> RUNNING -> ENDED, plus DESTROYED. Session-level races are in  *)
(* Session.tla; here the Host is a single sequential actor.                *)
(*                                                                         *)
(* The server issues turns (`next`) and receives results (`result`). The   *)
(* `finish` rule of run#A.7 / sc#A.9 is modelled so that F9 can be checked *)
(* against a cheating Host (Cheat = TRUE keeps playing after lives = 0).   *)
(*                                                                         *)
(* Out of scope: pause/resume (A.9), speed values (A.8), deck contents.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Cap,      \* upper bound on turns (50 in prod, run#A.2)
  Lives,    \* 3
  Cheat,    \* BOOLEAN: Host ignores lives = 0 (F9 only; F8 is checked with FALSE)
  LiteralWindow \* BOOLEAN: read A.15 F3 / A.5 step 7 literally, i.e. never
                \* issue a turn numbered above cur + 2 (see README: F6 fails)

ASSUME Cap \in Nat /\ Lives \in Nat /\ Cheat \in BOOLEAN /\ LiteralWindow \in BOOLEAN

Turns == 1..Cap
States == {"NONE", "LOADING", "READY", "INITED", "RUNNING", "ENDED", "DESTROYED"}
Vias   == {"guest", "timeout", "error"}

VARIABLES
  frame,     \* turn -> iframe state ("NONE" = not issued yet)
  cur,       \* displayed turn (slot N); 0 before the first start
  issued,    \* number of turns the server has issued
  isNew,     \* turn -> BOOLEAN (new-game slot: miss_below = null)
  lives,     \* Host's remaining lives
  missTurns, \* turns on which the Host counted a miss
  skipped,   \* turns that became skip
  hostDone,  \* Host knows the run is over (lives = 0 or cap reached)
  startedAfterZero, \* history: a `start` was sent while lives = 0 (F8)
  result,    \* server side: turn -> "open" | "miss" | "ok" | "skip"
  finished   \* server side: finish called

vars == << frame, cur, issued, isNew, lives, missTurns, skipped, hostDone,
           startedAfterZero, result, finished >>

Alive == {t \in Turns : frame[t] \in {"LOADING", "READY", "INITED", "RUNNING", "ENDED"}}

\* The next turn to start: the lowest issued, not-yet-destroyed turn after cur
Candidates == {t \in Turns : t > cur /\ frame[t] \in {"LOADING", "READY", "INITED"}}
NextTurn == CHOOSE t \in Candidates : \A u \in Candidates : t <= u

\* The Host is between turns (interlude) when nothing is running
InInterlude == ~hostDone /\ \A t \in Turns : frame[t] # "RUNNING"

Init ==
  /\ frame = [t \in Turns |-> "NONE"]
  /\ cur = 0 /\ issued = 0
  /\ isNew = [t \in Turns |-> FALSE]
  /\ lives = Lives /\ missTurns = {} /\ skipped = {}
  /\ hostDone = FALSE /\ startedAfterZero = FALSE
  /\ result = [t \in Turns |-> "open"]
  /\ finished = FALSE

(***************************************************************************)
(* Issuing turns (A.3, A.4, A.5 step 7). Slots N+1 and N+2 are positions,  *)
(* not turn numbers: the Host keeps two pending turns ahead of the         *)
(* displayed one. After a load skip the next turn is issued to refill the  *)
(* slot (see README: A.5 step 6 does not say this explicitly).             *)
(***************************************************************************)
Issue ==
  /\ ~hostDone /\ issued < Cap
  /\ Cardinality(Candidates) < 2
  /\ Cardinality(Alive) < 3
  /\ LiteralWindow => issued < (IF cur = 0 THEN 2 ELSE cur + 2)
  /\ \E new \in BOOLEAN :
       /\ issued' = issued + 1
       /\ frame' = [frame EXCEPT ![issued + 1] = "LOADING"]
       /\ isNew' = [isNew EXCEPT ![issued + 1] = new]
  /\ UNCHANGED << cur, lives, missTurns, skipped, hostDone, startedAfterZero, result, finished >>

\* `ready` arrives; the Host sends `init` right away (onInit, then wait)
Ready(t) ==
  /\ frame[t] = "LOADING"
  /\ frame' = [frame EXCEPT ![t] = "READY"]
  /\ UNCHANGED << cur, issued, isNew, lives, missTurns, skipped, hostDone, startedAfterZero, result, finished >>

Inited(t) ==
  /\ frame[t] = "READY"
  /\ frame' = [frame EXCEPT ![t] = "INITED"]
  /\ UNCHANGED << cur, issued, isNew, lives, missTurns, skipped, hostDone, startedAfterZero, result, finished >>

(***************************************************************************)
(* Interlude end (A.5 steps 5-7): start the next turn if INITED            *)
(***************************************************************************)
Start ==
  /\ InInterlude /\ Candidates # {}
  /\ frame[NextTurn] = "INITED"
  /\ (Cheat \/ lives > 0)
  /\ startedAfterZero' = (startedAfterZero \/ lives = 0)
  /\ frame' = [t \in Turns |-> IF t = NextTurn THEN "RUNNING"
                                ELSE IF t = cur THEN "DESTROYED" ELSE frame[t]]
  /\ cur' = NextTurn
  /\ UNCHANGED << issued, isNew, lives, missTurns, skipped, hostDone, result, finished >>

\* A.5 step 6: the next turn did not reach INITED within the extension
SkipLoad ==
  /\ InInterlude /\ Candidates # {}
  /\ frame[NextTurn] \in {"LOADING", "READY"}
  /\ frame' = [frame EXCEPT ![NextTurn] = "DESTROYED"]
  /\ skipped' = skipped \cup {NextTurn}
  /\ result' = [result EXCEPT ![NextTurn] = "skip"]
  /\ UNCHANGED << cur, issued, isNew, lives, missTurns, hostDone, startedAfterZero, finished >>

(***************************************************************************)
(* The displayed turn ends: `end` (guest), timer expiry, or `error` (A.5   *)
(* step 1, A.6, A.7). Miss is judged at that instant with the frozen       *)
(* threshold; via timeout/error is a skip and never a miss.                *)
(***************************************************************************)
End ==
  /\ cur # 0 /\ frame[cur] = "RUNNING"
  /\ \E via \in Vias, below \in BOOLEAN :
       LET miss == via = "guest" /\ ~isNew[cur] /\ below
           skip == via # "guest"
       IN /\ frame' = [frame EXCEPT ![cur] = "ENDED"]
          /\ lives' = IF miss /\ lives > 0 THEN lives - 1 ELSE lives
          /\ missTurns' = IF miss THEN missTurns \cup {cur} ELSE missTurns
          /\ skipped' = IF skip THEN skipped \cup {cur} ELSE skipped
          /\ result' = [result EXCEPT ![cur] = IF skip THEN "skip" ELSE IF miss THEN "miss" ELSE "ok"]
          /\ hostDone' = IF Cheat THEN FALSE ELSE (lives' = 0 \/ cur = Cap)
  /\ UNCHANGED << cur, issued, isNew, startedAfterZero, finished >>

\* No next turn can be obtained: the cap is reached (server returns done)
NoMoreTurns ==
  /\ ~hostDone /\ InInterlude /\ Candidates = {} /\ issued = Cap
  /\ hostDone' = TRUE
  /\ UNCHANGED << frame, cur, issued, isNew, lives, missTurns, skipped, startedAfterZero, result, finished >>

\* Run over: destroy every iframe, call finish (A.5 step 3, A.7)
Finish ==
  /\ hostDone /\ ~finished
  /\ frame' = [t \in Turns |-> IF frame[t] = "NONE" THEN "NONE" ELSE "DESTROYED"]
  /\ finished' = TRUE
  /\ UNCHANGED << cur, issued, isNew, lives, missTurns, skipped, hostDone, startedAfterZero, result >>

\* Cheating Host: keeps issuing/starting after lives = 0 but the server
\* still gets every result; it eventually calls finish.
CheatFinish ==
  /\ Cheat /\ ~finished /\ ~hostDone /\ lives = 0
  /\ hostDone' = TRUE
  /\ UNCHANGED << frame, cur, issued, isNew, lives, missTurns, skipped, startedAfterZero, result, finished >>

Next ==
  \/ Issue \/ \E t \in Turns : Ready(t) \/ Inited(t)
  \/ Start \/ SkipLoad \/ End \/ NoMoreTurns \/ Finish \/ CheatFinish

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(***************************************************************************)
(* Server-side record (sc#A.9): turns up to and including the 3rd miss,   *)
(* in turn order, counting skips. Results after that are dropped.          *)
(***************************************************************************)
MissesUpTo(t) == Cardinality({u \in 1..t : result[u] = "miss"})
ThirdMiss == IF \E t \in 1..issued : MissesUpTo(t) = Lives
             THEN CHOOSE t \in 1..issued : MissesUpTo(t) = Lives /\ MissesUpTo(t - 1) < Lives
             ELSE issued
Reached == ThirdMiss

(***************************************************************************)
(* Properties (run#A.15)                                                   *)
(***************************************************************************)
TypeOK == /\ frame \in [Turns -> States] /\ cur \in 0..Cap /\ issued \in 0..Cap
          /\ lives \in 0..Lives

Running == {t \in Turns : frame[t] = "RUNNING"}

F1 == Cardinality(Running) <= 1
F2 == \A t \in Running : t = cur
\* F3: alive iframes are the displayed turn plus at most two pending turns
\* (slot N, N+1, N+2). With turn numbers this is {cur, cur+1, cur+2} unless a
\* turn in between was skipped at load time.
F3 == Alive \subseteq {cur} \cup Candidates /\ Cardinality(Candidates) <= 2
F4 == Cardinality(Alive) <= 3
\* F5 is a guard of Start: the started frame is INITED. Recorded via F2/F1
\* plus the fact that RUNNING is only reachable from INITED in `frame`.
F5 == \A t \in Running : t \in Turns  \* placeholder; see F5Action
F5Action == [][\A t \in Turns : (frame[t] # "RUNNING" /\ frame'[t] = "RUNNING") => frame[t] = "INITED"]_vars
F7 == \A t \in missTurns : ~isNew[t]
F8 == ~startedAfterZero
\* F9: at finish, the record stops at the turn of the 3rd miss even when the
\* Host kept issuing turns after it (Cheat = TRUE); without a 3rd miss the
\* record is the number of issued turns (skips included, run#B.3).
F9 == finished =>
        /\ MissesUpTo(Reached) <= Lives
        /\ (Cardinality(missTurns) >= Lives
              => result[Reached] = "miss" /\ MissesUpTo(Reached) = Lives)
        /\ (Cardinality(missTurns) < Lives => Reached = issued)

Invariants == TypeOK /\ F1 /\ F2 /\ F3 /\ F4 /\ F7 /\ F9

\* F6: the run always ends (liveness; needs WF)
F6 == <>finished

=============================================================================
