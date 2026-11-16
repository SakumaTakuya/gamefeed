------------------------------ MODULE Publish ------------------------------
(***************************************************************************)
(* publish_game (mcp.md A.6, A.7, A.10) for one author: the transaction    *)
(* (steps 2-10), then R2 (step 11) and KV (step 12), either of which may   *)
(* fail after the commit. On `storage_failed` the client calls again with  *)
(* the same input (A.10). unpublish_game may happen in between.            *)
(*                                                                         *)
(* Abstractions: limited / public are one state `pub`; title / prompt,     *)
(* limits, static checks, removed and restricted are not modelled. The     *)
(* client makes one call at a time (the serialisation of step 12 against a *)
(* concurrent unpublish is not checked here).                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Rule,      \* "asis" = A.6 step 2 as written (#97); "D" = one table (#97 案 D)
  PostIds,   \* e.g. 1..2
  Hashes,    \* contents, e.g. {"h1", "h2"}
  MaxFaults  \* how many R2 / KV writes may fail in one behaviour

ASSUME Rule \in {"asis", "D"}

None == [base |-> "none", hash |-> "-"]
NoKv == [hash |-> "-", status |-> "-"]
Inputs == [pid : PostIds \cup {0}, html : Hashes, publish : BOOLEAN]

VARIABLES
  posts,    \* PostIds -> [base: none draft pub unpub, hash]
  stored,   \* hashes with games.stored_at set (the object is in R2)
  kv,       \* PostIds -> serve:<post_id> value, or NoKv
  pc,       \* client: "idle" | "failed" (got storage_failed, will call again)
  input,    \* the last publish_game input
  res,      \* the last result code
  retry,    \* the last call was a repeat of a storage_failed call
  faults

vars == << posts, stored, kv, pc, input, res, retry, faults >>

Rows == {p \in PostIds : posts[p].base # "none"}
Published(p) == posts[p].base \in {"pub", "unpub"}

Init ==
  /\ posts = [p \in PostIds |-> None] /\ stored = {} /\ kv = [p \in PostIds |-> NoKv]
  /\ pc = "idle" /\ input = [pid |-> 0, html |-> CHOOSE h \in Hashes : TRUE, publish |-> FALSE]
  /\ res = "init" /\ retry = FALSE /\ faults = 0

(***************************************************************************)
(* Steps 2-10. The outcome is a set of [code, target, posts] (a set only   *)
(* because A.7 may find several posts with the same content).              *)
(***************************************************************************)
Err(code) == {[code |-> code, target |-> 0, posts |-> posts]}
Keep(p)   == {[code |-> "ok", target |-> p, posts |-> posts]}
Write(p, i) ==
  {[code |-> "ok", target |-> p,
    posts |-> [posts EXCEPT ![p] = [base |-> IF i.publish THEN "pub" ELSE "draft", hash |-> i.html]]]}

\* A.7: no post_id. Same content of mine -> that post, nothing published.
ByContent(i) ==
  LET same == {p \in Rows : posts[p].hash = i.html}
      free == PostIds \ Rows
  IN IF same # {} THEN UNION {Keep(p) : p \in same}
     ELSE IF free = {} THEN {}   \* bound of the model, not a rule
     ELSE Write(CHOOSE p \in free : \A q \in free : p <= q, i)

Tx(i) ==
  IF i.pid = 0 THEN ByContent(i)
  ELSE IF posts[i.pid].base = "none" THEN Err("not_found")
  ELSE IF posts[i.pid].base = "draft" THEN Write(i.pid, i)
  ELSE IF Rule = "D" /\ posts[i.pid].hash = i.html THEN Keep(i.pid)
  ELSE Err("invalid_state")

(***************************************************************************)
(* Steps 11-12 after the commit. Each write either succeeds or fails.      *)
(***************************************************************************)
Call(i, isRetry) ==
  \E o \in Tx(i) :
    /\ posts' = o.posts /\ input' = i /\ retry' = isRetry
    /\ IF o.code # "ok"
       THEN /\ res' = o.code /\ pc' = "idle" /\ UNCHANGED << stored, kv, faults >>
       ELSE LET h == o.posts[o.target].hash IN
         \/ \* 11 fails
            /\ h \notin stored /\ faults < MaxFaults
            /\ faults' = faults + 1 /\ res' = "storage_failed" /\ pc' = "failed"
            /\ UNCHANGED << stored, kv >>
         \/ \* 11 ok (or not needed), 12 fails
            /\ faults < MaxFaults
            /\ stored' = stored \cup {h}
            /\ faults' = faults + 1 /\ res' = "storage_failed" /\ pc' = "failed"
            /\ UNCHANGED kv
         \/ \* both ok
            /\ stored' = stored \cup {h}
            /\ kv' = [kv EXCEPT ![o.target] = [hash |-> h, status |-> o.posts[o.target].base]]
            /\ res' = "ok" /\ pc' = "idle" /\ UNCHANGED faults

NewCall == pc = "idle" /\ \E i \in Inputs : Call(i, FALSE)
Retry   == pc = "failed" /\ Call(input, TRUE)   \* A.10: the same input again

\* unpublish_game (mo#A.2). Its own KV failure is not modelled.
Unpublish(p) ==
  /\ posts[p].base = "pub"
  /\ posts' = [posts EXCEPT ![p].base = "unpub"]
  /\ kv' = [kv EXCEPT ![p] = [hash |-> posts[p].hash, status |-> "unpub"]]
  /\ UNCHANGED << stored, pc, input, res, retry, faults >>

Next == NewCall \/ Retry \/ \E p \in PostIds : Unpublish(p)
Spec == Init /\ [][Next]_vars /\ WF_vars(Retry)

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
\* G1: calling again with the same input (A.10) is never refused.
G1 == retry => res \in {"ok", "storage_failed"}

\* G2: when no call is waiting to be repeated, R2 and KV agree with the DB
\*     for every post (a published post is never left unservable).
Synced(p) == posts[p].hash \in stored /\ kv[p] = [hash |-> posts[p].hash, status |-> posts[p].base]
G2 == pc = "idle" => \A p \in Rows : Synced(p)

\* G3: `ok` means the returned post is in R2 and KV.
G3 == res = "ok" /\ input.pid # 0 => Synced(input.pid)

\* G4 (I4 / I10): content does not change after publication.
G4 == [][\A p \in PostIds : Published(p) => posts'[p].hash = posts[p].hash]_vars

\* G5: repeating a call does not create a row and does not publish anything
\*     the failed call had not already published.
G5 == [][pc = "failed" => /\ Rows' = Rows
                          /\ \A p \in PostIds : Published(p)' => Published(p) \/ ~retry']_vars

\* G6: a failed call is eventually settled (faults are bounded).
G6 == [](pc = "failed" => <>(pc = "idle"))

\* G7 (idempotence): repeating a failed call changes nothing in the DB.
G7 == [][Retry => posts' = posts]_vars

\* G8 (idempotence): calling again with the input of a successful call
\*     changes nothing in the DB (even with unpublish_game in between).
G8 == [][NewCall /\ input' = input /\ res = "ok" => posts' = posts]_vars

Invariants == G1 /\ G2 /\ G3
=============================================================================
