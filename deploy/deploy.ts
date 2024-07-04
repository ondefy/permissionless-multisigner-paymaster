import { deployContract, getWallet } from "./utils";
import dotenv from "dotenv";

dotenv.config();
export default async function () {
  const contractArtifactName = "PermissionlessPaymaster";
  const constructorArguments = getWallet().address;
  await deployContract(contractArtifactName, [constructorArguments]);
}
