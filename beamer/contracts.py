import json
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import web3
from web3 import Web3
from web3.contract import Contract

from beamer.typing import Address, BlockNumber, ChainId


@dataclass
class ContractInfo:
    address: Address
    deployment_block: BlockNumber
    abi: list


def make_contracts(w3: web3.Web3, contracts_info: dict[str, ContractInfo]) -> dict[str, Contract]:
    return {
        name: cast(Contract, w3.eth.contract(info.address, abi=info.abi, decode_tuples=True))
        for name, info in contracts_info.items()
    }


def load_contract_abi(deployment_dir: Path, contract_name: str) -> list:
    with deployment_dir.joinpath(f"{contract_name}.json").open("rt") as f:
        data = json.load(f)
    return data["abi"]


DeploymentInfo = dict[ChainId, dict[str, ContractInfo]]


def load_deployment_info(deployment_dir: Path) -> DeploymentInfo:
    abis = {}
    deployment_info = {}
    with deployment_dir.joinpath("deployment.json").open("rt") as f:
        deployment = json.load(f)

    for chain_id, deployed_contracts in deployment["chains"].items():
        infos = {}
        for name, deployment_data in deployed_contracts.items():
            if name not in abis:
                abis[name] = load_contract_abi(deployment_dir, name)
            abi = abis[name]
            infos[name] = ContractInfo(
                address=deployment_data["address"],
                deployment_block=deployment_data["deployment_block"],
                abi=abi,
            )
        deployment_info[ChainId(int(chain_id))] = infos
    return deployment_info


def contracts_for_web3(web3: Web3, deployment_dir: Path) -> dict[str, Contract]:
    deployment_info = load_deployment_info(deployment_dir)
    chain_id = ChainId(web3.eth.chain_id)
    return make_contracts(web3, deployment_info[chain_id])
