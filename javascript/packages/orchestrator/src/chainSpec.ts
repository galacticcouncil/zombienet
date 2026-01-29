import { encodeAddress } from "@polkadot/util-crypto";
import {
  convertExponentials,
  CreateLogTable,
  decorators,
  getRandom,
  readDataFile,
} from "@zombienet/utils";
import crypto from "crypto";
import fs from "fs";
import { Transform } from "stream";
import { parser } from "stream-json";
import Assembler from "stream-json/Assembler";
import { JsonStreamStringify } from "json-stream-stringify";
import { generateKeyFromSeed } from "./keys";
import { ChainSpec } from "./types";
import { HrmpChannelsConfig, Node } from "./sharedTypes";
import { ComputedNetwork } from "./configTypes";
import { decorate, whichChain } from "./chain-decorators";
const JSONbig = require("json-bigint")({ useNativeBigInt: true });
const debug = require("debug")("zombie::chain-spec");

const JSONStream = require("JSONStream");

// track 1st staking as default;
let stakingBond: bigint | undefined;

export type KeyType = "session" | "aura" | "grandpa";

export type GenesisNodeKey = [string, string, { [key: string]: string }];

// Check if the chainSpec have session keys
export function specHaveSessionsKeys(chainSpec: ChainSpec): boolean {
  // Check runtime_genesis_config key for rococo compatibility.
  const runtimeConfig = getRuntimeConfig(chainSpec);

  return (
    runtimeConfig?.session ||
    runtimeConfig?.palletSession ||
    runtimeConfig?.authorMapping
  );
}

// Get authority keys from within chainSpec data
function getAuthorityKeys(chainSpec: ChainSpec, keyType: KeyType = "session") {
  const runtimeConfig = getRuntimeConfig(chainSpec);

  switch (keyType) {
    case "session":
      if (runtimeConfig?.session) return runtimeConfig.session.keys;
      break;
    case "aura":
      if (runtimeConfig?.aura) return runtimeConfig.aura.authorities;
      break;
    case "grandpa":
      if (runtimeConfig?.grandpa) return runtimeConfig.grandpa.authorities;
      break;
  }

  const errorMsg = `⚠ ${keyType} keys not found in runtimeConfig`;
  console.error(`\n\t\t  ${decorators.yellow(errorMsg)}`);
}

// Remove all existing keys from `session.keys` / aura.authorities / grandpa.authorities
export async function clearAuthorities(specPath: string) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);

    // clear keys
    if (runtimeConfig?.session) runtimeConfig.session.keys.length = 0;
    // clear aura
    if (runtimeConfig?.aura) runtimeConfig.aura.authorities.length = 0;
    // clear grandpa
    if (runtimeConfig?.grandpa) runtimeConfig.grandpa.authorities.length = 0;

    // clear collatorSelection
    if (runtimeConfig?.collatorSelection)
      runtimeConfig.collatorSelection.invulnerables = [];

    // clear staking (IFF not a para)
    // TODO: in the future we should add an option to override or not
    if (runtimeConfig?.staking && !runtimeConfig.parachainInfo) {
      // Set `stakingBond` IFF there is at least one
      if (runtimeConfig.staking.stakers[0])
        stakingBond = BigInt(runtimeConfig.staking.stakers[0][2]);

      runtimeConfig.staking.stakers = [];
      runtimeConfig.staking.invulnerables = [];
      runtimeConfig.staking.validatorCount = 0;
    }

    await writeChainSpec(specPath, chainSpec);
    const logTable = new CreateLogTable({
      colWidths: [120],
    });
    logTable.pushToPrint([
      [decorators.green("🧹 Starting with a fresh authority set...")],
    ]);
  } catch (err) {
    console.error(`\n${decorators.red("Fail to clear authorities")}`);
    throw err;
  }
}

export async function addBalances(specPath: string, nodes: Node[]) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);
    if (!runtimeConfig.balances) {
      console.error(
        `\n 🚧 ${decorators.yellow(
          "NO 'balances' key in runtimeConfig, skipping...",
        )} 🚧 \n`,
      );
      return;
    }

    // Create a balance map
    const balanceMap = runtimeConfig.balances.balances.reduce(
      (
        memo: Record<string, number | BigInt>,
        balance: [string, number | BigInt],
      ) => {
        memo[balance[0]] = balance[1];
        return memo;
      },
      {},
    );

    for (const node of nodes) {
      if (node.balance) {
        const stashKey = node.accounts.sr_stash.address;

        const balanceToAdd = stakingBond
          ? node.validator && node.balance > stakingBond
            ? node.balance
            : stakingBond! * BigInt(2) // Double the balance we use for stake
          : node.balance;

        balanceMap[stashKey] = balanceToAdd;

        const logLine = `👤 Added Balance ${balanceToAdd} for ${decorators.green(node.name)} - ${decorators.magenta(stashKey)}`;
        new CreateLogTable({
          colWidths: [120],
          doubleBorder: true,
        }).pushToPrint([[logLine]]);
      }
    }

    runtimeConfig.balances.balances = Object.entries(balanceMap);

    await writeChainSpec(specPath, chainSpec);
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add balance for nodes: ${nodes}`)}`,
    );
    throw err;
  }
}

export function getNodeKey(node: Node, useStash = true): GenesisNodeKey {
  try {
    const { sr_stash, sr_account, ed_account, ec_account } = node.accounts;

    const address = useStash ? sr_stash.address : sr_account.address;

    const key: GenesisNodeKey = [
      address,
      address,
      {
        grandpa: ed_account.address,
        babe: sr_account.address,
        im_online: sr_account.address,
        parachain_validator: sr_account.address,
        authority_discovery: sr_account.address,
        para_validator: sr_account.address,
        para_assignment: sr_account.address,
        beefy: encodeAddress(ec_account.publicKey),
        aura: sr_account.address,
        nimbus: sr_account.address,
        vrf: sr_account.address,
        mixnet: sr_account.address,
        bcsv: sr_account.address,
        ftsv: ed_account.address,
      },
    ];

    return key;
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to generate key for node: ${node}`)}`,
    );
    throw err;
  }
}

// Add additional authorities to chain spec in `session.keys`
export async function addAuthority(
  specPath: string,
  node: Node,
  key: GenesisNodeKey,
) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);

    const { sr_stash } = node.accounts;

    const keys = getAuthorityKeys(chainSpec);
    if (!keys) return;

    keys.push(key);

    new CreateLogTable({
      colWidths: [30, 20, 70],
    }).pushToPrint([
      [
        decorators.cyan("👤 Added Genesis Authority"),
        decorators.green(node.name),
        decorators.magenta(sr_stash.address),
      ],
    ]);

    await writeChainSpec(specPath, chainSpec);
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add authority for node: ${node}`)}`,
    );
    throw err;
  }
}

/// Add node to staking
export async function addStaking(specPath: string, node: Node) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);
    if (!runtimeConfig?.staking) return;

    const { sr_stash } = node.accounts;
    runtimeConfig.staking.stakers.push([
      sr_stash.address,
      sr_stash.address,
      stakingBond || BigInt(1000000000000),
      "Validator",
    ]);

    runtimeConfig.staking.validatorCount += 1;

    // add to invulnerables
    if (node.invulnerable)
      runtimeConfig.staking.invulnerables.push(sr_stash.address);

    new CreateLogTable({
      colWidths: [30, 20, 70],
    }).pushToPrint([
      [
        decorators.cyan("👤 Added Staking"),
        decorators.green(node.name),
        decorators.magenta(sr_stash.address),
      ],
    ]);

    await writeChainSpec(specPath, chainSpec);
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add staking for node: ${node}`)}`,
    );
    throw err;
  }
}

/// Add collators
export async function addCollatorSelection(specPath: string, node: Node) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);
    if (!runtimeConfig?.collatorSelection?.invulnerables) return;

    const { sr_account } = node.accounts;

    runtimeConfig.collatorSelection.invulnerables.push(sr_account.address);

    new CreateLogTable({
      colWidths: [30, 20, 70],
    }).pushToPrint([
      [
        decorators.cyan("👤 Added CollatorSelection "),
        decorators.green(node.name),
        decorators.magenta(sr_account.address),
      ],
    ]);

    await writeChainSpec(specPath, chainSpec);
  } catch (err) {
    console.error(`\n${decorators.red(`Fail to add collator: ${node}`)}`);
    throw err;
  }
}

export async function addParaCustom() {
  /// noop
}

export async function addAuraAuthority(
  specPath: string,
  name: string,
  accounts: any,
) {
  try {
    const { sr_account } = accounts;

    const chainSpec = await readAndParseChainSpec(specPath);

    const keys = getAuthorityKeys(chainSpec, "aura");
    if (!keys) return;

    keys.push(sr_account.address);

    await writeChainSpec(specPath, chainSpec);

    new CreateLogTable({
      colWidths: [30, 20, 70],
    }).pushToPrint([
      [
        decorators.cyan("👤 Added Genesis Authority"),
        decorators.green(name),
        decorators.magenta(sr_account.address),
      ],
    ]);
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add Aura account for node: ${name}`)}`,
    );
    throw err;
  }
}

export async function addGrandpaAuthority(
  specPath: string,
  name: string,
  accounts: any,
) {
  try {
    const { ed_account } = accounts;

    const chainSpec = await readAndParseChainSpec(specPath);

    const keys = getAuthorityKeys(chainSpec, "grandpa");
    if (!keys) return;

    keys.push([ed_account.address, 1]);

    await writeChainSpec(specPath, chainSpec);
    const logLine = `👤 Added Genesis Authority (GRANDPA) ${decorators.green(
      name,
    )} - ${decorators.magenta(ed_account.address)}`;
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [logLine],
    ]);
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add GrandPa account for node: ${name}`)}`,
    );
    throw err;
  }
}

export async function generateNominators(
  specPath: string,
  randomNominatorsCount: number,
  maxNominations: number,
  validators: string[],
) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);
    if (!runtimeConfig?.staking) return;

    let logLine = `👤 Generating random Nominators (${decorators.green(
      randomNominatorsCount,
    )})`;
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [logLine],
    ]);

    const maxForRandom = 2 ** 48 - 1;
    for (let i = 0; i < randomNominatorsCount; i++) {
      // create account
      const nom = await generateKeyFromSeed(`nom-${i}`);
      // add to balances
      const balanceToAdd = stakingBond! + BigInt(1);
      runtimeConfig.balances.balances.push([nom.address, balanceToAdd]);
      // random nominations
      const count = crypto.randomInt(maxForRandom) % maxNominations;
      const nominations = getRandom(validators, count || count + 1);
      // push to stakers
      runtimeConfig.staking.stakers.push([
        nom.address,
        nom.address,
        stakingBond,
        {
          Nominator: nominations,
        },
      ]);
    }

    await writeChainSpec(specPath, chainSpec);
    logLine = `👤 Added random Nominators (${decorators.green(
      randomNominatorsCount,
    )})`;
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [logLine],
    ]);
  } catch (err) {
    console.error(
      `\n${decorators.red(
        `Fail to generate staking config with count : ${randomNominatorsCount} and max : ${maxNominations}`,
      )}`,
    );
    throw err;
  }
}

// Add parachains to the chain spec at genesis.
export async function addParachainToGenesis(
  specPath: string,
  para_id: string,
  head: string,
  wasm: string,
  parachain = true,
) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const runtimeConfig = getRuntimeConfig(chainSpec);

    let paras = undefined;
    if (runtimeConfig.paras) {
      paras = runtimeConfig.paras.paras;
    }
    // For retro-compatibility with substrate pre Polkadot 0.9.5
    else if (runtimeConfig.parachainsParas) {
      paras = runtimeConfig.parachainsParas.paras;
    }
    // The config may not contain paras. Since chainspec allows to contain the RuntimeGenesisConfig patch we can inject it.
    else {
      runtimeConfig.paras = { paras: [] };
      paras = runtimeConfig.paras.paras;
    }
    if (paras) {
      const new_para = [
        parseInt(para_id),
        [readDataFile(head), readDataFile(wasm), parachain],
      ];

      paras.push(new_para);

      await writeChainSpec(specPath, chainSpec);
      const logLine = `${decorators.green(
        "✓ Added Genesis Parachain",
      )} ${para_id}`;
      new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
        [logLine],
      ]);
    } else {
      console.error(
        `\n${decorators.reverse(
          decorators.red("  ⚠ paras not found in runtimeConfig"),
        )}`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add para: ${para_id} to genesis`)}`,
    );
    throw err;
  }
}

// Update the runtime config in the genesis.
// It will try to match keys which exist within the configuration and update the value.
export async function changeGenesisConfig(specPath: string, updates: any) {
  try {
    const chainSpec = await readAndParseChainSpec(specPath);
    const msg = `⚙ Updating Chain Genesis Configuration (path: ${specPath})`;
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [`\n\t ${decorators.green(msg)}`],
    ]);

    if (chainSpec.genesis) {
      const config = chainSpec.genesis;
      findAndReplaceConfig(updates, config);

      await writeChainSpec(specPath, chainSpec);
    }
  } catch (err) {
    console.error(`\n${decorators.red("Fail to customize genesis")}`);
    throw err;
  }
}

export async function addBootNodes(specPath: string, addresses: string[]) {
  let chainSpec;
  try {
    chainSpec = await readAndParseChainSpec(specPath);
  } catch (e: any) {
    if (e.code !== "ERR_FS_FILE_TOO_LARGE") throw e;

    // can't customize bootnodes
    const logLine = ` 🚧 ${decorators.yellow(
      `Chain Spec file ${specPath} is TOO LARGE to customize (more than 2G).`,
    )} 🚧`;
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [logLine],
    ]);

    return;
  }

  // prevent dups bootnodes
  chainSpec.bootNodes = [...new Set(addresses)];
  await writeChainSpec(specPath, chainSpec);
  const logTable = new CreateLogTable({ colWidths: [120] });
  if (addresses.length) {
    logTable.pushToPrint([
      [`${decorators.green(chainSpec.name)} ⚙ Added Boot Nodes`],
      [addresses.join("\n")],
    ]);
  } else {
    logTable.pushToPrint([
      [`${decorators.green(chainSpec.name)} ⚙ Clear Boot Nodes`],
    ]);
  }
}

export async function addHrmpChannelsToGenesis(
  specPath: string,
  hrmp_channels: HrmpChannelsConfig[],
) {
  try {
    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [`\n\t ${decorators.green("Adding Genesis HRMP Channels")}`],
    ]);

    const chainSpec = await readAndParseChainSpec(specPath);

    for (const h of hrmp_channels) {
      const newHrmpChannel = [
        h.sender,
        h.recipient,
        h.max_capacity,
        h.max_message_size,
      ];

      const runtimeConfig = getRuntimeConfig(chainSpec);

      let hrmp = undefined;

      if (runtimeConfig.hrmp) {
        hrmp = runtimeConfig.hrmp;
      }
      // For retro-compatibility with substrate pre Polkadot 0.9.5
      else if (runtimeConfig.parachainsHrmp) {
        hrmp = runtimeConfig.parachainsHrmp;
      } else {
        // No hrmp key in the current chain-spec
        // let's create the struct and assign
        runtimeConfig["hrmp"] = {
          preopenHrmpChannels: [],
        };

        hrmp = runtimeConfig.hrmp;
      }

      if (hrmp && hrmp.preopenHrmpChannels) {
        hrmp.preopenHrmpChannels.push(newHrmpChannel);

        new CreateLogTable({
          colWidths: [120],
          doubleBorder: true,
        }).pushToPrint([
          [
            decorators.green(
              `✓ Added HRMP channel ${h.sender} -> ${h.recipient}`,
            ),
          ],
        ]);
      } else {
        console.error(
          `${decorators.reverse(
            decorators.red(`  ⚠ hrmp not found in runtimeConfig`),
          )}`,
        );
        process.exit(1);
      }

      await writeChainSpec(specPath, chainSpec);
    }
  } catch (err) {
    console.error(
      `\n${decorators.red(`Fail to add hrmp channels: ${hrmp_channels}`)}`,
    );
    throw err;
  }
}

// Look at the key + values from `obj1` (updates) and try to replace them in `obj2` (config)
function findAndReplaceConfig(obj1: any, obj2: any) {
  // create new Object without null prototype, this is a copy from the `config`.
  const tempObj = { ...obj2 };
  // Look at keys of obj1
  Object.keys(obj1).forEach((key) => {
    // See if obj2 also has this key
    if (tempObj.hasOwnProperty(key)) {
      // If it goes deeper, recurse...
      if (
        obj1[key] !== null &&
        obj1[key] !== undefined &&
        JSON.parse(JSON.stringify(obj1[key])).constructor === Object
      ) {
        findAndReplaceConfig(obj1[key], obj2[key]);
      } else {
        obj2[key] = obj1[key];
        new CreateLogTable({
          colWidths: [120],
          doubleBorder: true,
        }).pushToPrint([
          [
            `${decorators.green(
              "✓ Updated Genesis Configuration",
            )} [ key : ${key} ]`,
          ],
        ]);
        debug(`[ ${key}: ${JSON.stringify(obj2[key])} ]`);
      }
    } else {
      // Allow to add keys, see (https://github.com/paritytech/zombienet/issues/1614)
      const logLine = ` 🖋  ${decorators.yellow(
        `Key ${key} not present in the current config, adding...`,
      )}`;
      new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
        [logLine],
      ]);

      obj2[key] = obj1[key];
      new CreateLogTable({
        colWidths: [120],
        doubleBorder: true,
      }).pushToPrint([
        [
          `${decorators.green(
            "✓ Updated Genesis Configuration (added key)",
          )} [ key : ${key} ]`,
        ],
      ]);
      debug(`[ ${key}: ${JSON.stringify(obj2[key])} ]`);
    }
  });
}

export function getRuntimeConfig(chainSpec: any) {
  // runtime_genesis_config is no longer in ChainSpec after rococo runtime rework (refer to: https://github.com/paritytech/polkadot-sdk/pull/1256)
  // ChainSpec may contain a RuntimeGenesisConfigPatch
  return (
    chainSpec.genesis.runtimeGenesis?.config ||
    chainSpec.genesis.runtimeGenesis?.patch ||
    chainSpec.genesis.runtime?.runtime_genesis_config ||
    chainSpec.genesis.runtime
  );
}

async function parseChainSpecStream(specPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(specPath);
    const jsonParser = parser();
    const assembler = Assembler.connectTo(jsonParser);

    assembler.on("done", (asm: any) => resolve(asm.current));
    jsonParser.on("error", (err: Error) => reject(err));
    readStream.on("error", (err: Error) => reject(err));

    readStream.pipe(jsonParser);
  });
}

export async function readAndParseChainSpec(specPath: string): Promise<any> {
  try {
    const chainSpec = await parseChainSpecStream(specPath);
    return chainSpec;
  } catch (err: any) {
    console.error(
      `\n\t\t  ${decorators.red("  ⚠ failed to parse the chain spec")}`,
    );
    console.error(`\t\t  Error: ${err.message}`);
    process.exit(1);
  }
}

export async function writeChainSpec(
  specPath: string,
  chainSpec: any,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const replacer = (key: string, value: any) =>
      typeof value === "bigint" ? Number(value) : value;
    const jsonStream = new JsonStreamStringify(chainSpec, replacer);
    const chunks: string[] = [];

    jsonStream.on("data", (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    });

    jsonStream.on("error", (err: Error) => {
      console.error(
        `\n\t\t  ${decorators.reverse(
          decorators.red("  ⚠ failed to stringify the chain spec: "),
        )} ${err.message}`,
      );
      reject(err);
    });

    jsonStream.on("end", () => {
      try {
        const fullJson = chunks.join("");
        const converted = convertExponentials(fullJson);
        fs.writeFileSync(specPath, converted);
        resolve();
      } catch (err: any) {
        console.error(
          `\n\t\t  ${decorators.reverse(
            decorators.red("  ⚠ failed to write the chain spec with path: "),
          )} ${specPath}`,
        );
        reject(err);
      }
    });
  });
}

export async function isRawSpec(specPath: string): Promise<boolean> {
  return new Promise((res) => {
    const stream = fs.createReadStream(specPath, { encoding: "utf8" });
    const parser = JSONStream.parse(["genesis", "raw", "top", /^0x/]);
    stream.pipe(parser);
    parser.on("data", (e: any) => {
      debug(`data: ${e}`);
      stream.destroy();
      return res(true);
    });
    stream.on("end", () => {
      return res(false);
    });
  });
}

export async function getChainIdFromSpec(specPath: string): Promise<string> {
  return new Promise((res) => {
    const stream = fs.createReadStream(specPath, { encoding: "utf8" });
    const parser = JSONStream.parse(["id"]);
    stream.pipe(parser);
    parser.on("data", (id: any) => {
      debug(`data: ${id}`);
      stream.destroy();
      return res(id);
    });
    stream.on("end", () => {
      return res("");
    });
  });
}

export async function customizePlainRelayChain(
  specPath: string,
  networkSpec: ComputedNetwork,
): Promise<void> {
  try {
    // Relay-chain spec customization logic
    const plainRelayChainSpec = await readAndParseChainSpec(specPath);
    const keyType = specHaveSessionsKeys(plainRelayChainSpec)
      ? "session"
      : "aura";

    // make genesis overrides first.
    if (networkSpec.relaychain.genesis) {
      await changeGenesisConfig(specPath, networkSpec.relaychain.genesis);
    }

    // Clear all defaults
    clearAuthorities(specPath);

    // add balances for nodes
    await addBalances(specPath, networkSpec.relaychain.nodes);

    // add authorities for nodes
    const validatorKeys = [];
    for (const node of networkSpec.relaychain.nodes) {
      if (node.validator) {
        validatorKeys.push(node.accounts.sr_stash.address);

        if (keyType === "session") {
          const chain = whichChain(networkSpec.relaychain.chain);
          const [decoratedGetNodeKey] = decorate(chain, [getNodeKey]);
          const key = decoratedGetNodeKey(node);
          await addAuthority(specPath, node, key);
        } else {
          await addAuraAuthority(specPath, node.name, node.accounts!);
          await addGrandpaAuthority(specPath, node.name, node.accounts!);
        }

        await addStaking(specPath, node);
      }
    }

    if (networkSpec.relaychain.randomNominatorsCount) {
      await generateNominators(
        specPath,
        networkSpec.relaychain.randomNominatorsCount,
        networkSpec.relaychain.maxNominations,
        validatorKeys,
      );
    }

    if (networkSpec.hrmp_channels) {
      await addHrmpChannelsToGenesis(specPath, networkSpec.hrmp_channels);
    }
  } catch (err) {
    console.log(
      `\n ${decorators.red("Unexpected error: ")} \t ${decorators.bright(
        err,
      )}\n`,
    );
  }
}
export default {
  addAuraAuthority,
  addAuthority,
  changeGenesisConfig,
  clearAuthorities,
  readAndParseChainSpec,
  specHaveSessionsKeys,
  writeChainSpec,
  getNodeKey,
  addParaCustom,
  addCollatorSelection,
  isRawSpec,
  getChainIdFromSpec,
  customizePlainRelayChain,
};
