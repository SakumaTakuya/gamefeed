----------------------------- MODULE RunLog -----------------------------
(***************************************************************************)
(* Proposed run model (#151): the plan is frozen when the run is created,  *)
(* and the record is a log that the server extends one turn at a time, in  *)
(* turn order.                                                             *)
(*                                                                         *)
(* - `POST /runs` fixes the deck and, per deck entry, the threshold        *)
(*   (miss_below). Turn t -> deck position, lap, speed and seed is a pure  *)
(*   function shared by the Host and the server. There is no `next`.       *)
(* - The Host plays on its own and reports each turn. The server appends   *)
(*   result(t) only when t is the next turn of the log; anything else is   *)
(*   answered with the current length (idempotent, never an error state).  *)
(* - The run is closed when the log holds the Lives-th miss or the         *)
(*   Fails-th load failure, reaches the cap, `finish` arrives, or the run  *)
(*   expires. The record is the log.                                       *)
(*                                                                         *)
(* The network can lose, duplicate and reorder results. The Host can       *)
(* abort, give up waiting, or vanish. Same question as RunSync.tla: does   *)
(* the record agree with the run the player saw?                           *)
(*                                                                         *)
(* Slot control (F1-F5) is Host-local and stays in Run.tla.                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Cap, Lives,
  Fails,   \* load failures that end the run as a network error (3 in prod)
  Loss,    \* BOOLEAN: results can be lost; the Host may give up at the end
  Dup,     \* BOOLEAN: a result can be delivered more than once
  Abort,   \* BOOLEAN: the Host can abort
  Vanish,  \* BOOLEAN: the page can close without finish
  Expire,  \* BOOLEAN: the server closes the run by itself (run expiry)
  Cheat    \* BOOLEAN: arbitrary results are injected (dishonest client)

Turns == 1..Cap
\* "noload": the game was not loaded in time (load skip). "skip": timeout / error
Kinds == {"ok", "miss", "skip", "noload"}

VARIABLES
  thr,      \* turn -> BOOLEAN: the plan has a threshold for this turn
  \* --- server ---
  rec,      \* turn -> "none" | kind: the log
  settled,  \* length of the log
  frozen,   \* closed by finish or expiry
  \* --- network ---
  net,      \* results in flight: <<turn, kind>>
  acks,     \* log lengths the server has answered with
  \* --- host ---
  hKind,    \* turn -> "none" | kind: what the player saw
  cur,      \* running turn, 0 between turns
  lives,
  phase,    \* "play" | "closing" | "finished" | "gone"
  aborted,
  acked,    \* highest log length the Host has heard
  gaveUp    \* finish was called before every result was acknowledged

vars == << thr, rec, settled, frozen, net, acks, hKind, cur, lives, phase, aborted, acked, gaveUp >>

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

Played == {t \in Turns : hKind[t] # "none"}
HostReached == IF Played = {} THEN 0 ELSE Max(Played)
HostNoLoads == Cardinality({t \in Turns : hKind[t] = "noload"})
HostEndKind == IF lives = 0 THEN "lives" ELSE IF HostNoLoads >= Fails THEN "error"
               ELSE IF HostReached >= Cap THEN "limit" ELSE "abandoned"

RecMisses(n) == Cardinality({t \in 1..n : rec[t] = "miss"})
\* the server's view: nothing more can be appended
RecNoLoads(n) == Cardinality({t \in 1..n : rec[t] = "noload"})
Closed == frozen \/ RecMisses(settled) >= Lives \/ RecNoLoads(settled) >= Fails \/ settled >= Cap
SEndKind == IF RecMisses(settled) >= Lives THEN "lives"
            ELSE IF RecNoLoads(settled) >= Fails THEN "error"
            ELSE IF settled >= Cap THEN "limit" ELSE "abandoned"

Init ==
  /\ thr \in [Turns -> BOOLEAN]
  /\ rec = [t \in Turns |-> "none"] /\ settled = 0 /\ frozen = FALSE
  /\ net = {} /\ acks = {}
  /\ hKind = [t \in Turns |-> "none"] /\ cur = 0 /\ lives = Lives
  /\ phase = "play" /\ aborted = FALSE /\ acked = 0 /\ gaveUp = FALSE

(***************************************************************************)
(* Host: plays turn after turn without asking the server                    *)
(***************************************************************************)
HostStart ==
  /\ phase = "play" /\ cur = 0 /\ lives > 0 /\ HostReached < Cap
  /\ cur' = HostReached + 1
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, hKind, lives, phase, aborted, acked, gaveUp >>

\* the next turn is not loaded when it is needed: load skip. The Fails-th
\* one ends the run as a network error.
HostSkipLoad ==
  /\ phase = "play" /\ cur = 0 /\ HostReached < Cap
  /\ hKind' = [hKind EXCEPT ![HostReached + 1] = "noload"]
  /\ phase' = IF HostReached + 1 = Cap \/ HostNoLoads + 1 >= Fails THEN "closing" ELSE "play"
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, cur, lives, aborted, acked, gaveUp >>

HostEnd ==
  /\ phase = "play" /\ cur # 0
  /\ \E k \in {"ok", "miss", "skip"} :
       /\ (k = "miss" => thr[cur])
       /\ hKind' = [hKind EXCEPT ![cur] = k]
       /\ lives' = IF k = "miss" THEN lives - 1 ELSE lives
       /\ phase' = IF (k = "miss" /\ lives = 1) \/ cur = Cap THEN "closing" ELSE "play"
  /\ cur' = 0
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, aborted, acked, gaveUp >>

\* (re)send any played turn that is not acknowledged yet, in any order
HostSend(t) ==
  /\ phase \in {"play", "closing"}
  /\ t \in Played /\ t > acked
  /\ net' = net \cup {<<t, hKind[t]>>}
  /\ UNCHANGED << thr, rec, settled, frozen, acks, hKind, cur, lives, phase, aborted, acked, gaveUp >>

HostRecvAck(a) ==
  /\ a \in acks /\ a > acked
  /\ acked' = a
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, hKind, cur, lives, phase, aborted, gaveUp >>

HostAbort ==
  /\ Abort /\ phase = "play"
  /\ phase' = "closing" /\ aborted' = TRUE /\ cur' = 0
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, hKind, lives, acked, gaveUp >>

HostVanish ==
  /\ Vanish /\ phase \in {"play", "closing"}
  /\ phase' = "gone" /\ aborted' = TRUE /\ cur' = 0
  /\ UNCHANGED << thr, rec, settled, frozen, net, acks, hKind, lives, acked, gaveUp >>

\* finish: after every result is acknowledged, or after giving up
HostFinish ==
  /\ phase = "closing"
  /\ acked = HostReached \/ Loss \/ Expire
  /\ phase' = "finished" /\ gaveUp' = (acked # HostReached)
  /\ frozen' = TRUE
  /\ UNCHANGED << thr, rec, settled, net, acks, hKind, cur, lives, aborted, acked >>

(***************************************************************************)
(* Network and server                                                      *)
(***************************************************************************)
NetLose(m) ==
  /\ Loss /\ m \in net /\ net' = net \ {m}
  /\ UNCHANGED << thr, rec, settled, frozen, acks, hKind, cur, lives, phase, aborted, acked, gaveUp >>

\* append only the next turn of an open run; always answer with the length
Append(t, k) ==
  /\ IF ~Closed /\ t = settled + 1
     THEN /\ rec' = [rec EXCEPT ![t] = k]
          /\ settled' = settled + 1
     ELSE UNCHANGED << rec, settled >>
  /\ acks' = acks \cup {settled'}

ServerRecv(m) ==
  /\ m \in net
  /\ \/ net' = net \ {m}
     \/ Dup /\ net' = net
  /\ Append(m[1], m[2])
  /\ UNCHANGED << thr, frozen, hKind, cur, lives, phase, aborted, acked, gaveUp >>

ServerExpire ==
  /\ Expire /\ ~frozen /\ frozen' = TRUE
  /\ UNCHANGED << thr, rec, settled, net, acks, hKind, cur, lives, phase, aborted, acked, gaveUp >>

\* a dishonest client: any result for any turn reaches the server at any time
Inject ==
  /\ Cheat
  /\ \E t \in Turns, k \in Kinds : Append(t, k)
  /\ UNCHANGED << thr, frozen, net, hKind, cur, lives, phase, aborted, acked, gaveUp >>

Next ==
  \/ HostStart \/ HostSkipLoad \/ HostEnd \/ HostAbort \/ HostVanish \/ HostFinish
  \/ \E t \in Turns : HostSend(t)
  \/ \E a \in acks : HostRecvAck(a)
  \/ \E m \in net : NetLose(m) \/ ServerRecv(m)
  \/ ServerExpire \/ Inject

\* Fairness: the Host keeps playing and resending the oldest unacknowledged
\* turn; a result that the log is waiting for is eventually delivered (when
\* the network does not lose it); acknowledgements arrive; the run expires.
SendOldest == \E t \in Turns : t = acked + 1 /\ HostSend(t)
DeliverNext == \E m \in net : m[1] = settled + 1 /\ ~Closed /\ ServerRecv(m)
Spec == /\ Init /\ [][Next]_vars
        /\ WF_vars(HostStart \/ HostEnd \/ HostFinish)
        /\ WF_vars(SendOldest)
        /\ WF_vars(DeliverNext)
        /\ WF_vars(\E a \in acks : HostRecvAck(a))
        /\ WF_vars(ServerExpire)

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK == settled \in 0..Cap /\ lives \in 0..Lives /\ acked <= settled

\* B1: at every moment the record is a prefix of what the player saw
B1 == settled <= HostReached /\ \A t \in 1..settled : rec[t] = hKind[t]
\* B2 (= A4): the run stops only for a reason the player can see
B2 == phase \in {"closing", "finished"} =>
        lives = 0 \/ HostNoLoads >= Fails \/ HostReached >= Cap \/ aborted
\* B3 (= A1-A3): unless the Host gave up, the frozen record is the whole run
\* and ends for the reason the player saw
B3 == phase = "finished" /\ ~gaveUp =>
        /\ settled = HostReached
        /\ \A t \in 1..settled : rec[t] = hKind[t]
        /\ SEndKind = HostEndKind
\* B4: the log only grows at its end, one turn at a time, while the run is open
B4 == [][/\ \A t \in 1..settled : rec'[t] = rec[t]
         /\ settled' \in {settled, settled + 1}
         /\ (Closed => rec' = rec /\ settled' = settled)]_vars
\* B5 (= F9): nothing is recorded after the Lives-th miss, after the
\* Fails-th load failure or past the cap, whatever the client sends. A
\* client that reports misses as load failures gets at most Fails - 1 of them.
B5 == /\ settled <= Cap
      /\ (settled > 0 => RecMisses(settled - 1) < Lives /\ RecNoLoads(settled - 1) < Fails)
\* B6 (= A6): every run is eventually closed on the server, even if the page vanishes
B6 == <>Closed
\* B7: without loss, abort or expiry, the whole run is eventually recorded
B7 == <>(phase = "finished" /\ settled = HostReached)
=============================================================================
