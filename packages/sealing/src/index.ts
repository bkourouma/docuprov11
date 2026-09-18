// @archivage/sealing — cachet serveur (signature Ed25519 + horodatage interne).
//
// Extrait de `apps/api` le 2026-09-15, quand le worker s'est mis à sceller les documents dès leur
// ingestion : API et worker doivent signer avec EXACTEMENT le même code. Deux implémentations
// d'un mécanisme probatoire finissent toujours par diverger, et le jour où elles divergent, un
// cachet posé par l'un est déclaré invalide par l'autre — sans qu'on sache lequel a raison.

export * from './domain';
export * from './key';
