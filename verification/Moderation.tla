--------------------------- MODULE Moderation ---------------------------
(***************************************************************************)
(* Post status machine, lineage, reports, tree locks, BAN                  *)
(* (docs/moderation.md A.2, A.4 - A.7; data-model.md A.4, A.5).            *)
(*                                                                         *)
(* Users and NPosts posts. Post ids are issued in order, so parent < child *)
(* by construction (M1). Visibility is derived from base_status +          *)
(* indiv_restricted + tree_locks, as in dm#A.4 (the "derived" design that  *)
(* fixed old counterexamples 5 and 6).                                     *)
(*                                                                         *)
(* Design switch:                                                          *)
(*   Recheck  publish_game re-reads users.status under FOR SHARE inside   *)
(*            the insert transaction (dm#A.5 I3). FALSE reproduces old     *)
(*            counterexample 4 (M2 fails).                                  *)
(*                                                                         *)
(* Abstractions: report weights (auto restriction is a non-deterministic   *)
(* choice available only while a signed-in report is open), trust score   *)
(* (boolean), the distribution (a visible post may become calibrated at    *)
(* any time), content (not modelled: dm#A.5 I10, see M7).                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Users, NPosts, Recheck
ASSUME NPosts \in Nat /\ NPosts <= 3 /\ Recheck \in BOOLEAN

Posts == 1..NPosts
Bases == {"draft", "limited", "public", "unpublished", "removed"}

VARIABLES
  rows,       \* set of existing post ids
  np,         \* number of ids issued
  author,     \* post -> user
  parent,     \* post -> post or 0
  base,       \* post -> base_status
  indiv,      \* post -> indiv_restricted
  calib,      \* post -> "uncalibrated" | "calibrated"
  upheld,     \* post -> has an upheld report
  open,       \* post -> "none" | "anon" | "user" (open reports; a signed-in
              \*   report dominates because only it has weight, mo#A.4)
  treeLocks,  \* set of root post ids
  ustatus,    \* user -> active | post_restricted | banned
  trustHigh,  \* user -> BOOLEAN
  pending     \* user -> publish_game has passed the status check, insert not done

vars == << rows, np, author, parent, base, indiv, calib, upheld, open,
           treeLocks, ustatus, trustHigh, pending >>

postVars == << author, parent, base, indiv, calib, upheld, open >>

Init ==
  /\ rows = {} /\ np = 0
  /\ author = [p \in Posts |-> CHOOSE u \in Users : TRUE]
  /\ parent = [p \in Posts |-> 0]
  /\ base = [p \in Posts |-> "draft"]
  /\ indiv = [p \in Posts |-> FALSE]
  /\ calib = [p \in Posts |-> "uncalibrated"]
  /\ upheld = [p \in Posts |-> FALSE]
  /\ open = [p \in Posts |-> "none"]
  /\ treeLocks = {}
  /\ ustatus = [u \in Users |-> "active"]
  /\ trustHigh \in [Users -> BOOLEAN]
  /\ pending = [u \in Users |-> FALSE]

(***************************************************************************)
(* Derived views (dm#A.4)                                                  *)
(***************************************************************************)
\* ancestors including self; NPosts <= 3 so three levels suffice
Anc(p) == {p} \cup (IF parent[p] = 0 THEN {} ELSE {parent[p]})
              \cup (IF parent[p] = 0 \/ parent[parent[p]] = 0 THEN {} ELSE {parent[parent[p]]})
Desc(r) == {p \in rows : r \in Anc(p)}

TreeLocked(p) == Anc(p) \cap treeLocks # {}

Status(p) ==
  IF base[p] \in {"removed", "unpublished", "draft"} THEN base[p]
  ELSE IF indiv[p] \/ TreeLocked(p) THEN "restricted"
  ELSE base[p]

Visible(p) == p \in rows /\ Status(p) \in {"limited", "public"}

CanPromote(p) == ~indiv[p] /\ ~upheld[p]
PublishTarget(p) == IF trustHigh[author[p]] THEN "public" ELSE "limited"

(***************************************************************************)
(* publish_game: new draft (mc#A.6, mo#A.2, I3)                            *)
(***************************************************************************)
Check(u) ==
  /\ ustatus[u] = "active" /\ ~pending[u] /\ np < NPosts
  /\ pending' = [pending EXCEPT ![u] = TRUE]
  /\ UNCHANGED << rows, np, postVars, treeLocks, ustatus, trustHigh >>

Insert(u) ==
  /\ pending[u] /\ np < NPosts
  /\ (~Recheck \/ ustatus[u] = "active")
  /\ \E par \in {0} \cup {q \in rows : base[q] # "draft"} :
       LET p == np + 1 IN
       /\ rows' = rows \cup {p} /\ np' = p
       /\ author' = [author EXCEPT ![p] = u]
       /\ parent' = [parent EXCEPT ![p] = par]
       /\ base' = [base EXCEPT ![p] = "draft"]
  /\ pending' = [pending EXCEPT ![u] = FALSE]
  /\ UNCHANGED << indiv, calib, upheld, open, treeLocks, ustatus, trustHigh >>

Publish(p) ==
  /\ p \in rows /\ base[p] = "draft" /\ ustatus[author[p]] = "active"
  /\ base' = [base EXCEPT ![p] = PublishTarget(p)]
  /\ UNCHANGED << rows, np, author, parent, indiv, calib, upheld, open, treeLocks, ustatus, trustHigh, pending >>

DeleteDraft(p) ==
  /\ p \in rows /\ base[p] = "draft"
  /\ rows' = rows \ {p}
  /\ UNCHANGED << np, postVars, treeLocks, ustatus, trustHigh, pending >>

(***************************************************************************)
(* Calibration becomes calibrated: limited -> public promotion (mo#A.2)    *)
(***************************************************************************)
Calibrate(p) ==
  /\ p \in rows /\ calib[p] = "uncalibrated" /\ base[p] \in {"limited", "public"}
  /\ calib' = [calib EXCEPT ![p] = "calibrated"]
  /\ base' = [base EXCEPT ![p] = IF base[p] = "limited" /\ CanPromote(p) THEN "public" ELSE base[p]]
  /\ UNCHANGED << rows, np, author, parent, indiv, upheld, open, treeLocks, ustatus, trustHigh, pending >>

Unpublish(p) ==
  /\ p \in rows /\ base[p] \in {"limited", "public"}
  /\ base' = [base EXCEPT ![p] = "unpublished"]
  /\ UNCHANGED << rows, np, author, parent, indiv, calib, upheld, open, treeLocks, ustatus, trustHigh, pending >>

Republish(p) ==
  /\ p \in rows /\ base[p] = "unpublished"
  /\ base' = [base EXCEPT ![p] = IF calib[p] = "calibrated" /\ CanPromote(p) THEN "public" ELSE PublishTarget(p)]
  /\ UNCHANGED << rows, np, author, parent, indiv, calib, upheld, open, treeLocks, ustatus, trustHigh, pending >>

(***************************************************************************)
(* Reports (mo#A.4)                                                        *)
(***************************************************************************)
Report(p) ==
  /\ p \in rows /\ Status(p) \in {"limited", "public", "restricted"}
  /\ \E anon \in BOOLEAN :
       open' = [open EXCEPT ![p] = IF ~anon \/ @ = "user" THEN "user" ELSE "anon"]
  /\ UNCHANGED << rows, np, author, parent, base, indiv, calib, upheld, treeLocks, ustatus, trustHigh, pending >>

\* the weight sum crossed a threshold: only signed-in reports have weight
AutoRestrict(p) ==
  /\ p \in rows /\ open[p] = "user" /\ ~indiv[p]
  /\ indiv' = [indiv EXCEPT ![p] = TRUE]
  /\ UNCHANGED << rows, np, author, parent, base, calib, upheld, open, treeLocks, ustatus, trustHigh, pending >>

(***************************************************************************)
(* Moderator operations (mo#A.7)                                           *)
(***************************************************************************)
Uphold(p) == upheld[p] \/ open[p] # "none"

Restrict(p) ==
  /\ p \in rows /\ base[p] \notin {"draft", "removed"}
  /\ indiv' = [indiv EXCEPT ![p] = TRUE]
  /\ upheld' = [upheld EXCEPT ![p] = Uphold(p)]
  /\ open' = [open EXCEPT ![p] = "none"]
  /\ UNCHANGED << rows, np, author, parent, base, calib, treeLocks, ustatus, trustHigh, pending >>

Restore(p) ==
  /\ p \in rows /\ base[p] \in {"limited", "public", "unpublished"}
  /\ indiv' = [indiv EXCEPT ![p] = FALSE]
  /\ open' = [open EXCEPT ![p] = "none"]
  /\ UNCHANGED << rows, np, author, parent, base, calib, upheld, treeLocks, ustatus, trustHigh, pending >>

Remove(p) ==
  /\ p \in rows /\ base[p] \in {"limited", "public", "unpublished"}
  /\ base' = [base EXCEPT ![p] = "removed"]
  /\ upheld' = [upheld EXCEPT ![p] = Uphold(p)]
  /\ open' = [open EXCEPT ![p] = "none"]
  /\ UNCHANGED << rows, np, author, parent, indiv, calib, treeLocks, ustatus, trustHigh, pending >>

RestrictTree(r) ==
  /\ r \in rows /\ r \notin treeLocks /\ base[r] # "draft"
  /\ treeLocks' = treeLocks \cup {r}
  /\ upheld' = [p \in Posts |-> IF p \in Desc(r) THEN Uphold(p) ELSE upheld[p]]
  /\ open' = [p \in Posts |-> IF p \in Desc(r) THEN "none" ELSE open[p]]
  /\ UNCHANGED << rows, np, author, parent, base, indiv, calib, ustatus, trustHigh, pending >>

RestoreTree(r) ==
  /\ r \in treeLocks
  /\ treeLocks' = treeLocks \ {r}
  /\ UNCHANGED << rows, np, postVars, ustatus, trustHigh, pending >>

RestrictUser(u) ==
  /\ ustatus[u] = "active"
  /\ ustatus' = [ustatus EXCEPT ![u] = "post_restricted"]
  /\ UNCHANGED << rows, np, postVars, treeLocks, trustHigh, pending >>

RestoreUser(u) ==
  /\ ustatus[u] = "post_restricted"
  /\ ustatus' = [ustatus EXCEPT ![u] = "active"]
  /\ UNCHANGED << rows, np, postVars, treeLocks, trustHigh, pending >>

\* BAN (mo#A.5): every post of the user that is not yet removed becomes
\* removed in the same transaction. Drafts are deleted (mo#A.2 / B.6 say a
\* draft is never `removed`; see README for the gap in the wording of A.5).
Ban(u) ==
  /\ ustatus[u] # "banned"
  /\ LET mine == {p \in rows : author[p] = u}
         hit  == {p \in mine : base[p] \notin {"draft", "removed"}}
     IN
     /\ ustatus' = [ustatus EXCEPT ![u] = "banned"]
     /\ rows' = rows \ {p \in mine : base[p] = "draft"}
     /\ base' = [p \in Posts |-> IF p \in hit THEN "removed" ELSE base[p]]
     /\ upheld' = [p \in Posts |-> IF p \in hit THEN Uphold(p) ELSE upheld[p]]
     /\ open' = [p \in Posts |-> IF p \in mine THEN "none" ELSE open[p]]
  /\ UNCHANGED << np, author, parent, indiv, calib, treeLocks, trustHigh, pending >>

Next ==
  \/ \E u \in Users : Check(u) \/ Insert(u) \/ RestrictUser(u) \/ RestoreUser(u) \/ Ban(u)
  \/ \E p \in Posts :
       \/ Publish(p) \/ DeleteDraft(p) \/ Calibrate(p)
       \/ Unpublish(p) \/ Republish(p) \/ Report(p) \/ AutoRestrict(p)
       \/ Restrict(p) \/ Restore(p) \/ Remove(p) \/ RestrictTree(p) \/ RestoreTree(p)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties (mo#A.10)                                                    *)
(***************************************************************************)
TypeOK == /\ rows \subseteq Posts /\ np \in 0..NPosts
          /\ \A p \in Posts : base[p] \in Bases /\ parent[p] \in 0..NPosts

\* M1: no cycles (parent < child); parent never changes after insert
M1 == \A p \in rows : parent[p] = 0 \/ parent[p] < p
M1Action == [][\A p \in rows : parent'[p] = parent[p]]_vars

\* M2: every post of a banned user is removed
M2 == \A u \in Users : ustatus[u] = "banned" =>
        \A p \in rows : author[p] = u => base[p] = "removed"

\* M3: removed is terminal
M3 == [][\A p \in Posts : base[p] = "removed" => base'[p] = "removed"]_vars

\* M4: individually restricted posts are never visible (restore is the only exit)
M4 == \A p \in rows : indiv[p] => ~Visible(p)

\* M5: no descendant of a locked root is visible (including later inserts)
M5 == \A r \in treeLocks : \A p \in Desc(r) : ~Visible(p)

\* M6: removing a parent does not delete the child row (rows only shrink
\* for drafts, which have no children)
M6 == \A p \in rows : parent[p] = 0 \/ parent[p] \in rows

\* M7: unpublished returns only to limited / public (or is removed).
\* Content is not modelled: dm#A.5 I10 allows changes only in draft, and no
\* action of this module touches content after publish by construction.
M7 == [][\A p \in Posts : base[p] = "unpublished" /\ base'[p] # "unpublished"
            => base'[p] \in {"limited", "public", "removed"}]_vars

\* M8: a restricted post that stays restricted (indiv or tree lock still
\* set after the step) is never visible after the step, whatever the step
\* (restore, republish, promotion, restore_tree of another root ...)
M8 == [][\A p \in rows : (Status(p) = "restricted" /\ (indiv'[p] \/ (Anc(p) \cap treeLocks' # {})))
            => ~(p \in rows' /\ Status(p)' \in {"limited", "public"})]_vars

\* M9: indiv_restricted is cleared only by restore; tree locks only by restore_tree
M9 == [][/\ (\E p \in Posts : indiv[p] /\ ~indiv'[p]) => \E p \in Posts : Restore(p)
         /\ (\E r \in treeLocks : r \notin treeLocks') => \E r \in Posts : RestoreTree(r)]_vars

\* M10: anonymous reports alone never auto-restrict: when indiv_restricted
\* is set by something other than a moderator's restrict, a signed-in
\* report was open
M10 == [][\A p \in Posts : (~indiv[p] /\ indiv'[p] /\ ~Restrict(p)) => open[p] = "user"]_vars

Invariants == TypeOK /\ M1 /\ M2 /\ M4 /\ M5 /\ M6

Sym == Permutations(Users)

=============================================================================
