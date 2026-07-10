// ASIT family — verbatim duplicate of src/operators/asit.ts so the MCP
// package builds independently of the main app. Keep in sync by hand if the
// webapp tweaks any doctrine or promptFragment text.

import type { OperatorDefinition } from './types.js';

export const ASIT_OPERATORS: OperatorDefinition[] = [
  {
    family: 'ASIT',
    key: 'unification',
    name: 'Unification',
    glyph: '⊕',
    oneLiner: 'One element, two roles.',
    doctrine:
      'Unification (Task Unification): keep the components of the system and the closed world fixed; let one of those components also perform an additional, unrelated task. Example: a phone screen also serves as a mirror.',
    promptFragment:
      'Apply the ASIT operator UNIFICATION (Task Unification): keep the existing components of the system fixed, and propose 3–5 partitions in which an EXISTING component is given an additional, previously-unrelated task. Do not introduce foreign components. Each partition should specify which component takes the new task and what that task is.',
  },
  {
    family: 'ASIT',
    key: 'multiplication',
    name: 'Multiplication',
    glyph: '×',
    oneLiner: 'Add a copy with a small variation.',
    doctrine:
      'Multiplication: take an existing component and add a copy of it that differs in at least one property (size, position, timing, sensitivity). Closed-world: do not import alien parts.',
    promptFragment:
      'Apply the ASIT operator MULTIPLICATION: propose 3–5 partitions, each adding a near-copy of an EXISTING component but with at least one altered property (size, count, timing, location, sensitivity). State which component is duplicated and which property is altered.',
  },
  {
    family: 'ASIT',
    key: 'division',
    name: 'Division',
    glyph: '÷',
    oneLiner: 'Split one element into independent parts.',
    doctrine:
      'Division: divide an existing component into parts and rearrange them. Splits can be physical (space), temporal (time), or functional (by attribute/condition).',
    promptFragment:
      'Apply the ASIT operator DIVISION: propose 3–5 partitions in which an EXISTING component is divided along space, time, or condition, and the parts are reorganised. State which component is divided and along which axis.',
  },
  {
    family: 'ASIT',
    key: 'object_removal',
    name: 'Object Removal',
    glyph: '⊖',
    oneLiner: 'Eliminate, then redistribute the role.',
    doctrine:
      'Object Removal (Subtraction): remove a component that seems essential. The remaining system must achieve the goal — often by reassigning that role to another component (forces unification).',
    promptFragment:
      'Apply the ASIT operator OBJECT REMOVAL: propose 3–5 partitions, each removing one component that currently seems essential. For each, state which component is removed and how the remaining system still achieves the goal.',
  },
  {
    family: 'ASIT',
    key: 'breaking_symmetry',
    name: 'Breaking Symmetry',
    glyph: '⤧',
    oneLiner: 'Replace a uniform property with a gradient.',
    doctrine:
      'Breaking Symmetry: take a property that is currently uniform across the system (in space, time, users, or conditions) and make it vary as a function of one of those variables.',
    promptFragment:
      'Apply the ASIT operator BREAKING SYMMETRY: propose 3–5 partitions, each turning a currently-uniform property of the system into one that varies with a contextual variable (location, time, user, condition). State the property and the variable it now depends on.',
  },
];
