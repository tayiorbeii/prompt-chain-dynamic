# Project Architecture

## Overview

Describe the product and its major runtime boundaries.

## Technology stack

List languages, frameworks, package managers, runtimes, databases, and deployment targets with versions where material.

## Repository structure

Document important directories and ownership boundaries.

## Core data flows

Describe primary request, event, persistence, and background-job flows.

## Architectural principles

- Existing patterns to preserve
- Error-handling conventions
- State-management conventions
- Module boundaries
- Testing seams

## Quality commands

List the exact targeted and final validation commands supported by this repository.

## High-risk shared paths

List manifests, lockfiles, migrations, shared schemas/types, auth policy, generated snapshots, and root configuration that should normally be serialized.

## Update rule

Update this document during release when an accepted change materially changes architecture. Keep it curated rather than exhaustive.
