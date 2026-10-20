# packages/graph-ui/src/view-route.ts

## Facts
- graph-ui/src/view-route.ts's viewResponse answers any view name purely over a ReadModel via ui-core's readView, falling back to a caller-supplied DoorAnswers only when the log's answer is an empty array. {5bx8f3a8 @packages/graph-ui/src/view-route.ts#viewResponse #architecture-current}

## Why
- A door answers a view the log has not filled, such as the model catalog before any discovery, because live discovery calls provider APIs which a pure view fold may not; it applies to an empty array only, never to a missing subject. {sdzregqr @packages/graph-ui/src/view-route.ts#DoorAnswers}
