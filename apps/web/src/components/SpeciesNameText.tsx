import { Fragment } from "react";
import { namePartClass, type NamePart } from "../lib/speciesName";

// A species card's second line (other name, codes), each part keeping its own style.
export default function SpeciesNameText({ parts }: { parts: NamePart[] }) {
  return parts.map((part, i) => (
    <Fragment key={`${part.kind}:${part.text}`}>
      {i > 0 && " · "}
      <span className={namePartClass(part)}>{part.text}</span>
    </Fragment>
  ));
}
